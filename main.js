const os = require('os');
const inquirer = require('inquirer');
const {spawn, exec} = require('child_process');
const open = require('open');
const http = require('http');
const dgram = require('dgram');
const net = require('net');
const {URL} = require('url');
const path = require('path');
const fs = require('fs');
const SERVER_PORT = 3000;
const AVR_CONTROL_PORT = 1256;
const CONFIG = {timeouts: {discovery: 5000, connection: 3000, command: 10000}}; 
const rewApiPort = 4735;

let cachedAvrConfig = null;
let receivedOptimizationData = null;
let mainServer = null;

function getBasePath() {
  if (process.pkg) {
    // path.dirname(process.execPath) gives the directory of the .exe itself
    return path.dirname(process.execPath);
  } else {
    return __dirname; // Development: project root
  }
}
const APP_BASE_PATH = getBasePath();
const CONFIG_FILENAME = 'receiver_config.avr';
const CONFIG_FILEPATH = path.join(APP_BASE_PATH, CONFIG_FILENAME);
const HTML_FILENAME = 'A1Evo.html'; 
let HTML_FILEPATH;
if (process.pkg) {
    HTML_FILEPATH = path.join(__dirname, HTML_FILENAME);
    console.log(`Platform: ${process.platform}`);
} else {
    HTML_FILEPATH = path.join(__dirname, HTML_FILENAME);
}
if (!fs.existsSync(HTML_FILEPATH)) {
    console.error(`[ERROR] File system check failed for: ${HTML_FILEPATH}`);
    throw new Error(`Required file ${HTML_FILENAME} not found at ${HTML_FILEPATH}! Cannot start optimization.`);
}
console.log(`Base path for external files: ${APP_BASE_PATH}`);
console.log(`Attempting to load configuration from: ${CONFIG_FILEPATH}`);
function runNodeScript(scriptPath, dataToSend = null) {
    return new Promise((resolve, reject) => {
        console.log(`\n--- Running ${path.basename(scriptPath)} ---`);
        const nodePath = process.execPath;
        const child = spawn(nodePath, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdout.on('data', (data) => { process.stdout.write(data); });
        child.stderr.on('data', (data) => { process.stderr.write(`ERROR [${path.basename(scriptPath)}]: ${data}`); });
        child.on('error', (error) => { console.error(`Failed to start ${scriptPath}: ${error}`); reject(error); });
        child.on('close', (code) => {
            console.log(`--- ${path.basename(scriptPath)} finished with code ${code} ---`);
            if (code === 0) resolve();
            else reject(new Error(`${path.basename(scriptPath)} exited with code ${code}`));
        });
        if (dataToSend) {
            try {
                child.stdin.write(JSON.stringify(dataToSend));
                child.stdin.end();
            } catch (err) {
                 console.error(`Error writing data to ${scriptPath}: ${err.message}`);
                 child.kill();
                 reject(err);
            }
        } else {
             child.stdin.end();
        }
    });
}
class UPNPDiscovery {
     constructor(timeout = 5000) {
        this.socket = dgram.createSocket('udp4');
        this.SSDP_MULTICAST_ADDR = '239.255.255.250';
        this.SSDP_PORT = 1900;
        this.SEARCH_TARGETS = ['urn:schemas-denon-com:device:Receiver:1', 'upnp:rootdevice'];
        this.timeout = timeout;
    }
     discover() {
        return new Promise((resolve, reject) => {
            const devices = new Map();
            let discoveryTimer;
            const finishDiscovery = () => {
                clearTimeout(discoveryTimer);
                 try {
                    if (this.socket && this.socket.address()) {
                         this.socket.close(() => {
                            resolve(Array.from(devices.values()));
                         });
                    } else {
                         resolve(Array.from(devices.values()));
                    }
                 } catch (closeError) {
                     console.error("Error closing discovery socket:", closeError);
                     resolve(Array.from(devices.values()));
                 }
            };
            discoveryTimer = setTimeout(finishDiscovery, this.timeout);
            this.socket.on('error', (err) => {
                console.error(`Discovery socket error:\n${err.stack}`);
                clearTimeout(discoveryTimer);
                try { this.socket.close(); } catch (e) {}
                reject(err);
            });
            this.socket.on('message', (msg, rinfo) => {
                const response = msg.toString();
                if (response.includes('HTTP/1.1 200 OK') && response.includes('LOCATION:')) {
                    const locationMatch = response.match(/LOCATION:\s*(.+)/i);
                    const usnMatch = response.match(/USN:\s*(.+)/i);
                    const serverMatch = response.match(/SERVER:\s*(.+)/i);
                    if (locationMatch && locationMatch[1]) {
                        const locationUrl = locationMatch[1].trim();
                        this.fetchDeviceDescription(locationUrl)
                            .then((deviceInfo) => {
                                if (!devices.has(deviceInfo.descriptionUrl) && deviceInfo.modelName && deviceInfo.modelName !== 'Unknown Model') {
                                     console.log(`Found device: ${deviceInfo.manufacturer} ${deviceInfo.modelName} at ${rinfo.address}`);
                                    devices.set(deviceInfo.descriptionUrl, {
                                        address: rinfo.address,
                                        port: rinfo.port, 
                                        usn: usnMatch ? usnMatch[1].trim() : null,
                                        server: serverMatch ? serverMatch[1].trim() : null,
                                        ...deviceInfo
                                    });
                                }
                            })
                        .catch(err => console.error(`Error fetching description for ${locationUrl}: ${err.message}`));
                    }
                }
            });
            this.socket.bind(() => {
                 try {
                    this.socket.setBroadcast(true);
                    this.socket.addMembership(this.SSDP_MULTICAST_ADDR);
                    console.log(`Searching network for AV receivers via UPnP (Timeout: ${this.timeout / 1000}s)...`);
                    this.SEARCH_TARGETS.forEach(target => {
                        const searchRequest = Buffer.from(
                            'M-SEARCH * HTTP/1.1\r\n' +
                            `HOST: ${this.SSDP_MULTICAST_ADDR}:${this.SSDP_PORT}\r\n` +
                            'MAN: "ssdp:discover"\r\n' +
                            'MX: 2\r\n' + 
                            `ST: ${target}\r\n\r\n`
                        );
                        this.socket.send(searchRequest, 0, searchRequest.length, this.SSDP_PORT, this.SSDP_MULTICAST_ADDR, (err) => {
                            if (err) {
                                console.error(`Error sending M-SEARCH for target ${target}: ${err}`);
                            }
                        });
                    });
                } catch (bindErr) {
                     clearTimeout(discoveryTimer);
                     console.error("Error binding or setting up discovery socket:", bindErr);
                      try { this.socket.close(); } catch (e) {}
                     reject(bindErr);
                }
            });
        });
    }
    fetchDeviceDescription(locationUrl) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(locationUrl);
            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || 80, 
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'GET',
                timeout: CONFIG.timeouts.command 
            };
            const req = http.request(options, (res) => {
                let data = '';
                if (res.statusCode !== 200) {
                     if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                          console.log(`Following redirect from ${locationUrl} to ${res.headers.location}`);
                          res.resume(); 
                          this.fetchDeviceDescription(res.headers.location).then(resolve).catch(reject); 
                          return;
                     }
                     console.warn(`Failed to get description ${locationUrl}. Status: ${res.statusCode}`);
                     res.resume(); 
                     resolve({ modelName: 'Unknown Model', manufacturer: 'Unknown Manufacturer', friendlyName: 'Unknown Device', descriptionUrl: locationUrl });
                     return;
                }
                res.setEncoding('utf8');
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const modelNameMatch = data.match(/<modelName>(.*?)<\/modelName>/i);
                        const manufacturerMatch = data.match(/<manufacturer>(.*?)<\/manufacturer>/i);
                        const friendlyNameMatch = data.match(/<friendlyName>(.*?)<\/friendlyName>/i);
                        const clean = (str) => str ? str.replace(/<!\[CDATA\[(.*?)\]\]>/, '$1').trim() : 'Unknown';
                        const modelName = modelNameMatch ? clean(modelNameMatch[1]) : 'Unknown Model';
                        const manufacturer = manufacturerMatch ? clean(manufacturerMatch[1]) : 'Unknown Manufacturer';
                        const friendlyName = friendlyNameMatch ? clean(friendlyNameMatch[1]) : 'Unknown Device';
                        resolve({
                            modelName: modelName,
                            manufacturer: manufacturer,
                            friendlyName: friendlyName,
                            descriptionUrl: locationUrl 
                        });
                    } catch (error) {
                        console.error("Error parsing device description XML:", error, "\nXML Data (first 500 chars):", data.substring(0, 500));
                        resolve({ modelName: 'Unknown Model', manufacturer: 'Unknown Manufacturer', friendlyName: 'Unknown Device', descriptionUrl: locationUrl });
                    }
                });
            });
            req.on('error', (e) => {
                 console.error(`Error requesting description ${locationUrl}: ${e.message} (Code: ${e.code})`);
                 resolve({ modelName: 'Unknown Model', manufacturer: 'Unknown Manufacturer', friendlyName: 'Unknown Device', descriptionUrl: locationUrl });
            });
             req.on('timeout', () => {
                 req.destroy(); 
                 console.warn(`Timeout requesting description ${locationUrl}`);
                  resolve({ modelName: 'Unknown Model', manufacturer: 'Unknown Manufacturer', friendlyName: 'Unknown Device', descriptionUrl: locationUrl });
             });
            req.end();
        });
    }
    static async interactiveDeviceSelection(devices) {
        if (!devices || devices.length === 0) {
            console.log("No devices provided for selection.");
            return null;
        }
        const choices = devices.map((device, index) => ({
            name: `[${index + 1}] ${device.friendlyName || 'Unknown Name'} (${device.manufacturer || 'Unknown Manuf.'} ${device.modelName || 'Unknown Model'}) - ${device.address}`,
            value: index
        }));
        choices.push(new inquirer.Separator());
        choices.push({ name: 'Cancel / Enter IP Manually', value: -1 }); 
        const answers = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedDeviceIndex',
                message: 'Multiple potential AVRs found via UPnP. Select the target device:',
                choices: choices,
                pageSize: Math.min(15, choices.length + 1) 
            }
        ]);
        if (answers.selectedDeviceIndex === -1) {
            console.log("Device selection cancelled or user chose manual entry.");
            return null;
        }
        return devices[answers.selectedDeviceIndex];
    }
}
async function connectToAVR(ip, port = AVR_CONTROL_PORT, timeout = CONFIG.timeouts.connection) { 
  return new Promise((resolve, reject) => {
    console.log(`Attempting to connect to ${ip}:${port} (Timeout: ${timeout / 1000}s)...`);
    const client = net.createConnection({ port, host: ip, timeout });
    let connectionTimeoutTimer; 
    const cleanup = () => {
        clearTimeout(connectionTimeoutTimer);
        client.removeAllListeners('connect');
        client.removeAllListeners('error');
        client.removeAllListeners('timeout'); 
    };
    connectionTimeoutTimer = setTimeout(() => {
         console.error(`Connection to ${ip}:${port} timed out after ${timeout}ms.`);
         client.destroy(); 
         reject(new Error(`Connection timed out after ${timeout}ms.`));
     }, timeout);
    client.once('connect', () => {
      cleanup(); 
      console.log(`Successfully connected to ${ip}:${port}.`);
      resolve(client); 
    });
    client.once('error', err => {
      cleanup(); 
      console.error(`Connection error to ${ip}:${port}: ${err.message}`);
      reject(new Error(`Connection error: ${err.message}`));
    });
    client.once('timeout', () => {
        cleanup();
        console.error(`Connection to ${ip}:${port} timed out (net.createConnection event).`);
        client.destroy();
        reject(new Error(`Connection timed out (net.createConnection event) after ${timeout}ms.`));
    });
  });
}
async function getAvrInfoAndStatus(socket, commandTimeout = CONFIG.timeouts.command) { 
  const sendRawAndParseJson = (hexWithChecksum, label) =>
    new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const packet = Buffer.from(hexWithChecksum, 'hex');
      let commandTimer; 
      let isActive = true; 
      const cleanup = (error = null) => {
        if (!isActive) return; 
        isActive = false;
        socket.removeListener('data', onData);
        socket.removeListener('error', onError); 
        clearTimeout(commandTimer);
        if (error) {
             reject(error);
        }
      };
      const onData = (data) => {
        if (!isActive) return; 
        buffer = Buffer.concat([buffer, data]);
        const utf8 = buffer.toString('utf8');
        const jsonStart = utf8.indexOf('{');
        const jsonEnd = utf8.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
          const potentialJson = utf8.slice(jsonStart, jsonEnd + 1);
          try {
            const parsed = JSON.parse(potentialJson);
            //console.log(`[${label}] Successfully parsed JSON response.`);
            cleanup(); 
            resolve(parsed);
          } catch (err) {
             if (buffer.length > 1 * 1024 * 1024) { 
                cleanup(new Error(`[${label}] Response buffer exceeded 1MB without valid JSON.`));
             }
          }
        } else {
        }
      };
      const onError = (err) => {
        console.error(`[${label}] Socket error during command: ${err.message}`);
        cleanup(new Error(`Socket error during ${label}: ${err.message}`));
      };
      commandTimer = setTimeout(() => {
        console.error(`[${label}] Command timed out after ${commandTimeout}ms waiting for JSON response.`);
        cleanup(new Error(`[${label}] Timed out waiting for JSON response.`));
      }, commandTimeout);
      socket.on('data', onData);
      socket.on('error', onError); 
      //console.log(`Sending command [${label}]...`);
      socket.write(packet, (err) => {
        if (err) {
          console.error(`[${label}] Socket write error: ${err.message}`);
          cleanup(new Error(`Write error during ${label}: ${err.message}`));
        } else {
        }
      });
    });
  try {
      //console.log("Fetching AVR Information (GET_AVRINF)...");
      const infoJson = await sendRawAndParseJson('54001300004745545f415652494e460000006c', 'GET_AVRINF');
      console.log("AVR Information received.");
      await new Promise(resolve => setTimeout(resolve, 200)); 
      //console.log("Fetching AVR Status (GET_AVRSTS)...");
      const statusJson = await sendRawAndParseJson('54001300004745545f41565253545300000089', 'GET_AVRSTS');
      console.log("AVR Status received.");
      let activeChannels = [];
      let rawChSetup = [];
      let ampAssignString = null;
      let assignBin = null;
      let eqTypeString = "";
      if (infoJson?.EQType) eqTypeString = infoJson.EQType;
      else if (infoJson?.Audyssey?.Version) eqTypeString = infoJson.Audyssey.Version; 
      if (statusJson?.ChSetup && Array.isArray(statusJson.ChSetup)) {
          rawChSetup = statusJson.ChSetup;
          activeChannels = statusJson.ChSetup
              .filter(entry => entry && typeof entry === 'object' && Object.values(entry)[0] !== 'N') 
              .map(entry => Object.keys(entry)[0]); 
           console.log(`Detected Active Channels: ${activeChannels.join(', ') || 'None'}`);
      } else {
          console.warn("Channel Setup data (ChSetup) missing or invalid in AVR status response.");
      }
      ampAssignString = statusJson?.AmpAssign;
      assignBin = statusJson?.AssignBin; 
      if (!ampAssignString) console.warn("AmpAssign string missing from AVR status.");
      if (!assignBin) console.warn("AssignBin string (ampAssignInfo) missing from AVR status.");
      return {
          ip: socket.remoteAddress, 
          rawChSetup,
          ampAssignString,
          assignBin, 
          eqTypeString,
      };
  } catch (error) {
      console.error(`Failed to get necessary AVR status/info: ${error.message}`);
      throw new Error(`Failed during AVR status/info retrieval: ${error.message}`);
  }
}
function formatDataForFrontend(details) {
     if (!details) {
          throw new Error("Cannot format data: Input details object is missing.");
     }
     const targetModelName = details.modelName || 'Unknown Model'; 
     const ipAddress = details.ip || null; 
     const eqTypeString = details.eqTypeString || ""; 
     const ampAssignString = details.ampAssignString; 
     const assignBin = details.assignBin; 
     const rawChSetup = details.rawChSetup || []; 
     let enMultEQType = null; 
     if (typeof eqTypeString === 'string' && eqTypeString) {
         if (eqTypeString.includes('XT32')) enMultEQType = 2;
         else if (eqTypeString.includes('XT')) enMultEQType = 1; 
         else if (eqTypeString.includes('MultEQ')) enMultEQType = 0; 
     }
     if (enMultEQType === null) {
         console.warn(`Could not determine MultEQ Type from EQ string: "${eqTypeString}". Defaulting may be needed or configuration might fail.`);
     }
     if (!ampAssignString) console.warn("Amp Assign string missing. Frontend functionality might be limited.");
     if (!assignBin) console.warn("Amp Assign Info (AssignBin) missing. Frontend functionality might be limited.");
     let detectedChannels = [];
     let subCount = 0;
     if (Array.isArray(rawChSetup)) {
          rawChSetup.forEach(entry => {
              if (!entry || typeof entry !== 'object') return; 
              const commandId = Object.keys(entry)[0]; 
              const speakerType = entry[commandId]; 
              if (speakerType !== 'N') {
                  let standardizedId = commandId;
                  if (commandId.startsWith('SWMIX')) {
                       standardizedId = commandId.replace('MIX', ''); 
                  }
                  detectedChannels.push({ commandId: standardizedId });
                  if (standardizedId.startsWith('SW') || standardizedId === 'LFE') { 
                      subCount++;
                  }
              }
          });
     } else {
         console.warn("Channel Setup data missing or invalid. Cannot determine active channels or sub count.");
     }
     if (detectedChannels.length === 0 && rawChSetup.length > 0) {
          console.warn("Channel Setup data was present, but no active channels (non-'N') were found.");
     } else if (detectedChannels.length === 0) {
         console.warn("No active channels detected.");
     }
     const simplifiedConfig = {
         targetModelName: targetModelName,
         ipAddress: ipAddress,
         enMultEQType: enMultEQType, 
         subwooferNum: subCount,
         ampAssign: ampAssignString || null, 
         ampAssignInfo: assignBin || null, 
         detectedChannels: detectedChannels 
     };
     return simplifiedConfig;
}
async function fetchModelFromGoform(ipAddress) {
    return new Promise((resolve) => {
        const url = `http://${ipAddress}/goform/formMainZone_MainZoneXml.xml`;
        //console.log(`Attempting to fetch model name from ${url} (Timeout: ${CONFIG.timeouts.command / 1000}s)...`);
        const options = {
            method: 'GET',
            timeout: CONFIG.timeouts.command 
        };
        const req = http.request(url, options, (res) => { 
            let data = '';
            if (res.statusCode !== 200) {
                console.warn(`Failed to get ${url}. Status: ${res.statusCode} ${res.statusMessage}`);
                res.resume(); 
                resolve(null); 
                return;
            }
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const modelMatch = data.match(/<ModelName>\s*<value>(.*?)<\/value>\s*<\/ModelName>/i);
                    const friendlyMatch = data.match(/<FriendlyName>\s*<value>(.*?)<\/value>\s*<\/FriendlyName>/i);
                    let modelName = modelMatch ? modelMatch[1].trim() : null;
                    const friendlyName = friendlyMatch ? friendlyMatch[1].trim() : null;
                    let finalName = modelName;
                    let source = modelName ? "ModelName tag" : "None";
                    if (!modelName || /receiver|network (audio|av)|(av|media) (server|renderer|player)/i.test(modelName)) {
                       if (friendlyName && friendlyName.length > 3 && !/receiver|network (audio|av)|(av|media) (server|renderer|player)/i.test(friendlyName)) {
                           //console.log(`Using FriendlyName ("${friendlyName}") as model, as ModelName ("${modelName}") was generic or missing.`);
                           finalName = friendlyName;
                           source = "FriendlyName tag";
                       } else {
                           console.log(`ModelName ("${modelName}") was generic/missing, and FriendlyName ("${friendlyName}") was also unusable or absent.`);
                           finalName = null; 
                           source = "None Found";
                       }
                    }
                    if (finalName) {
                         console.log(`Model name identified as "${finalName}" via /goform/ (${source}).`);
                    } else {
                         console.log("Could not identify a specific model name via /goform/.");
                    }
                    resolve(finalName); 
                } catch (parseError) {
                    console.error(`Error parsing XML from ${url}:`, parseError);
                    resolve(null); 
                }
            });
        });
        req.on('error', (e) => {
            console.error(`Error requesting ${url}: ${e.message} (Code: ${e.code})`);
            resolve(null); 
        });
        req.on('timeout', () => {
            req.destroy(); 
            console.error(`Timeout requesting ${url} after ${CONFIG.timeouts.command}ms`);
            resolve(null); 
        });
        req.end(); 
    });
}
async function runFullDiscoveryAndSave(interactive = true) {
    //console.log('\nStarting AVR discovery and configuration process...');
    let targetIp = null;
    let modelName = null;
    let manufacturer = null; 
    let initialFriendlyName = null; 
    let modelSource = "None"; 
    let avrFoundViaDiscovery = false;
    let selectedInitialInfo = null; 
    try {
        const discovery = new UPNPDiscovery(CONFIG.timeouts.discovery);
        let devices = await discovery.discover();
        //console.log(`Found ${devices.length} distinct device description(s).`);
        const potentialAvrs = devices.filter(dev =>
            (dev.usn && /Receiver/i.test(dev.usn)) || 
            /Denon|Marantz/i.test(dev.manufacturer || '') || 
            (/AVR|Receiver|SR|NR|AV|Cinema/i.test(dev.modelName || '') && !/MediaRenderer|MediaServer/i.test(dev.modelName || '')) || 
            (/AVR|Receiver|SR|NR|AV|Cinema/i.test(dev.friendlyName || '') && !/MediaRenderer|MediaServer/i.test(dev.friendlyName || '')) 
        );
        console.log(`Found ${potentialAvrs.length} AVR matching description(s).`);
        const groupedByIp = potentialAvrs.reduce((acc, device) => {
            const ip = device.address;
            if (ip) {
                 if (!acc[ip]) acc[ip] = [];
                 acc[ip].push(device);
            }
            return acc;
        }, {});
        const uniqueIPs = Object.keys(groupedByIp);
        console.log(`Found ${uniqueIPs.length} unique IP address(es) for potential AVRs.`);
        if (uniqueIPs.length === 1) {
            targetIp = uniqueIPs[0];
            const descriptionsForIp = groupedByIp[targetIp];
            selectedInitialInfo = descriptionsForIp.find(d => d.modelName && !/Unknown|MediaRenderer|MediaServer/i.test(d.modelName)) ||
                                 descriptionsForIp.find(d => d.friendlyName && !/Unknown|MediaRenderer|MediaServer/i.test(d.friendlyName)) ||
                                 descriptionsForIp[0]; 
            avrFoundViaDiscovery = true;
            console.log(`Automatically selected single matching AVR at ${targetIp}`);
        } else if (uniqueIPs.length > 1 && interactive) {
            console.warn(`Multiple matching AVR IPs found via UPnP.`);
            const choicesForPrompt = uniqueIPs.map(ip => {
                 const descriptions = groupedByIp[ip];
                 return descriptions.find(d => d.modelName && !/Unknown|MediaRenderer|MediaServer/i.test(d.modelName)) ||
                        descriptions.find(d => d.friendlyName && !/Unknown|MediaRenderer|MediaServer/i.test(d.friendlyName)) ||
                        descriptions[0]; 
            }).filter(Boolean); 
            selectedInitialInfo = await UPNPDiscovery.interactiveDeviceSelection(choicesForPrompt);
            if (selectedInitialInfo) {
                 avrFoundViaDiscovery = true;
                 targetIp = selectedInitialInfo.address;
                 console.log(`User selected AVR at ${targetIp}`);
            } else {
                 console.log("No device selected by user from UPnP list.");
            }
        } else if (uniqueIPs.length > 1 && !interactive) {
            console.error("Automatic check failed: Multiple potential AVR IPs found via UPnP. Cannot auto-select.");
            return false; 
        }
        if (selectedInitialInfo) {
             modelName = selectedInitialInfo.modelName;
             manufacturer = selectedInitialInfo.manufacturer;
             initialFriendlyName = selectedInitialInfo.friendlyName;
             if (modelName && !/Unknown Model|MediaRenderer|MediaServer/i.test(modelName)) {
                 modelSource = "UPnP Description XML";
             } else {
                 console.log(`UPnP provided model name "${modelName}" is unreliable or missing. Will try other methods.`);
                 modelName = null; 
             }
        }
    } catch (discoveryError) {
        console.error(`Error during UPnP discovery phase: ${discoveryError.message}`);
    }
    if (!targetIp && interactive) {
        console.log("\nUPnP discovery did not identify a target AVR IP, or selection was cancelled.");
        try {
            const ipAnswer = await inquirer.prompt([{
                type: 'input', name: 'manualIp', message: 'Please enter the AVR IP address manually (or leave blank to cancel):',
                validate: input => {
                     if (input === '') return true; 
                     return (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input)) ? true : 'Please enter a valid IPv4 address or leave blank.';
                }
            }]);
            if (ipAnswer.manualIp) {
                targetIp = ipAnswer.manualIp;
                console.log(`Using manually entered IP: ${targetIp}`);
                modelName = null; 
                manufacturer = null; 
                initialFriendlyName = null; 
                modelSource = "Manual IP (Model Unknown)";
                selectedInitialInfo = { address: targetIp }; 
            } else {
                 console.log("Manual IP entry cancelled.");
            }
        } catch (promptError) {
            console.error("Error during manual IP prompt:", promptError);
            return false; 
        }
    }
    if (!targetIp) {
        console.error("Configuration aborted: No target IP address could be determined.");
        return false;
    }
    if (modelSource !== "/goform/ XML") {
        console.log(`\nAttempting to verify/find model name via /goform/ endpoint on ${targetIp}...`);
        const goformModel = await fetchModelFromGoform(targetIp);
        if (goformModel) { 
            if (!modelName) { 
                modelName = goformModel;
                modelSource = "/goform/ XML";
                console.log(`Model name identified as "${modelName}" via /goform/.`);
            } else { 
                const upnpLower = modelName.toLowerCase();
                const goformLower = goformModel.toLowerCase();
                if (upnpLower === goformLower) {
                    console.log(`Model name "${modelName}" confirmed via /goform/.`);
                    modelSource = "/goform/ XML (Confirmed UPnP)";
                } else {
                    const upnpLast6 = upnpLower.length >= 6 ? upnpLower.slice(-6) : null;
                    const goformLast6 = goformLower.length >= 6 ? goformLower.slice(-6) : null;
                    if (upnpLast6 && goformLast6 && upnpLast6 === goformLast6) {
                        //console.log(`Partial model match: UPnP "${modelName}", /goform/ "${goformModel}". Using /goform/ version as base model matches.`);
                        modelName = goformModel; 
                        modelSource = "/goform/ XML (Partial Match Accepted)";
                    } else {
                        console.warn(`Model name discrepancy: UPnP reported "${modelName}", /goform/ reports "${goformModel}".`);
                        if (interactive) {
                            const confirmGoform = await inquirer.prompt([{
                                type: 'confirm', name: 'useGoform',
                                message: `UPnP reported "${modelName}" but /goform/ reports "${goformModel}". These seem different. Use the /goform/ version ("${goformModel}")?`,
                                default: true 
                            }]);
                            if (confirmGoform.useGoform) {
                                modelName = goformModel;
                                modelSource = "/goform/ XML (User Confirmed Discrepancy)";
                            } else {
                                modelSource += " (User Rejected /goform/ Version)";
                            }
                        } else {
                            console.log(`Non-interactive mode: Discrepancy detected. Preferring /goform/ version "${goformModel}".`);
                            modelName = goformModel;
                            modelSource = "/goform/ XML (Auto-selected on Discrepancy)";
                        }
                    }
                }
            }
        } else {
            console.log("Could not get a valid model name from /goform/ endpoint.");
            if (!modelName) modelSource = "None Found"; 
        }
    }
    let finalModelName = modelName; 
    if (interactive) {
        let promptForModel = false;
        if (finalModelName && finalModelName !== 'Unknown Model') { 
            const confirm = await inquirer.prompt([{
                type: 'confirm', name: 'isCorrect',
                message: `Is "${finalModelName}" the correct model for the device at ${targetIp}? (Source: ${modelSource})`,
                default: true
            }]);
            if (!confirm.isCorrect) {
                 finalModelName = null; 
                 promptForModel = true;
            }
        } else {
            console.log("\nCould not automatically determine or confirm the AVR model name.");
            promptForModel = true;
        }
        if (promptForModel) {
            const modelPrompt = await inquirer.prompt([{
                type: 'input', name: 'modelNameManual',
                message: 'Please enter the correct AVR Model Name (e.g., SR6011, X3800H):',
                validate: input => (input && input.trim().length > 1) ? true : 'Model name cannot be empty.' 
            }]);
            finalModelName = modelPrompt.modelNameManual.trim();
            modelSource = "Manual Entry (User Provided)"; 
        }
    } else { 
         if (!finalModelName || finalModelName === 'Unknown Model') {
             console.error(`Automatic check failed: Could not determine a valid AVR Model Name for ${targetIp}. (Last attempt source: ${modelSource})`);
             return false;
         }
         console.log(`Using automatically determined model name: "${finalModelName}" (Source: ${modelSource})`);
    }
    if (!finalModelName) {
        console.error("Configuration aborted: Final Model Name could not be determined.");
        return false;
    }
    let socket = null; 
    let avrOperationalData = null;
    try {
        socket = await connectToAVR(targetIp); 
        //console.log(`Successfully connected to ${targetIp}:${AVR_CONTROL_PORT}. Fetching operational status...`);
        avrOperationalData = await getAvrInfoAndStatus(socket, CONFIG.timeouts.command);
        //console.log("Successfully retrieved operational status from AVR.");
    } catch (err) {
         console.error(`Error during connection or status fetch for ${targetIp}: ${err.message}`);
         if (socket && !socket.destroyed) {
             socket.destroy();
             console.log(`Socket to ${targetIp} destroyed after error.`);
         }
         return false; 
    } finally {
         if (socket && !socket.destroyed) {
             socket.end(() => {
             });
         }
    }
    try {
       const finalDetails = {
           ip: avrOperationalData.ip, 
           rawChSetup: avrOperationalData.rawChSetup,
           ampAssignString: avrOperationalData.ampAssignString,
           assignBin: avrOperationalData.assignBin,
           eqTypeString: avrOperationalData.eqTypeString,
           modelName: finalModelName, 
           manufacturer: manufacturer || '', 
           friendlyName: initialFriendlyName || '', 
       };
       const frontendData = formatDataForFrontend(finalDetails);
       console.log(`\nSaving configuration to ${CONFIG_FILENAME} for model "${frontendData.targetModelName}" at ${frontendData.ipAddress}...`);
       fs.writeFileSync(CONFIG_FILEPATH, JSON.stringify(frontendData, null, 2));
       console.log('Configuration saved successfully.');
       cachedAvrConfig = frontendData; 
       return true; 
    } catch (formatSaveError) {
        console.error(`Error formatting or saving configuration: ${formatSaveError.message}`);
        return false; 
    }
}
function loadConfigFromFile() {
    if (fs.existsSync(CONFIG_FILEPATH)) {
        try {
            console.log(`Loading configuration from file: ${CONFIG_FILENAME}...`);
            const fileContent = fs.readFileSync(CONFIG_FILEPATH, 'utf-8');
            cachedAvrConfig = JSON.parse(fileContent);
            if (!cachedAvrConfig.ipAddress || !cachedAvrConfig.targetModelName) {
                 console.warn(`Warning: Loaded config from ${CONFIG_FILENAME} seems incomplete (missing IP or Model Name). Consider re-running configuration.`);
            } else {
                console.log(`Configuration loaded for: ${cachedAvrConfig.targetModelName} at ${cachedAvrConfig.ipAddress}`);
            }
            return true;
        } catch (error) {
            console.error(`Error reading or parsing ${CONFIG_FILENAME}: ${error.message}`);
            cachedAvrConfig = null; 
            return false;
        }
    } else {
        cachedAvrConfig = null;
        return false;
    }
}
async function mainMenu() {
    const configExists = loadConfigFromFile(); 
    if (!configExists && !cachedAvrConfig) { 
        console.warn(`\nAVR Configuration (${CONFIG_FILENAME}) is missing or invalid.`);
    }
    const configOptionName = configExists
        ? "1. Re-create and save AVR configuration file"
        : "1. Discover AVR in the network and create and save configuration file";
    const optimizeDisabled = !configExists || !cachedAvrConfig?.ipAddress; 
    const transferDisabled = optimizeDisabled; 
    const choices = [
        { name: configOptionName, value: 'config' },
        {
            name: `2. Start Optimization (opens A1 Evo Acoustica in your browser)${optimizeDisabled ? ' (Requires valid configuration file)' : ''}`,
            value: 'optimize',
            disabled: optimizeDisabled
        },
        {
            name: `3. Transfer Calibration (requires at least one '.oca' calibration file in this folder)${transferDisabled ? ' (Requires valid configuration file)' : ''}`,
            value: 'transfer',
            disabled: transferDisabled
        },
        new inquirer.Separator(),
        { name: 'Exit', value: 'exit' },
    ];
    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Choose an action:',
            choices: choices,
        },
    ]);
    switch (answers.action) {
        case 'config':
            const success = await runFullDiscoveryAndSave(true); 
            if (success) {
                 //console.log("AVR configuration completed successfully.");
            } else {
                 console.error("AVR configuration process failed or was cancelled.");
            }
            await mainMenu(); 
            break;
        case 'optimize':
            if (!cachedAvrConfig || !cachedAvrConfig.ipAddress) {
                console.error(`\nError: Cannot start optimization. Configuration (${CONFIG_FILENAME}) is missing or invalid.`);
                console.warn("Please run Option 1 first.");
                await mainMenu();
                break;
            }
            if (!fs.existsSync(HTML_FILEPATH)) {
                console.error(`\nError: Required file ${HTML_FILENAME} not found at ${HTML_FILEPATH}! Cannot start optimization.`);
                await mainMenu();
                break;
            }
            const rewReady = await ensureRewReady();
            if (!rewReady) {
                console.warn("\nREW check failed or user chose not to proceed. Aborting optimization.");
                await mainMenu(); 
                break;
            }
            console.log('\n--- Starting Optimization ---');
            const optimizationUrl = `http://localhost:${SERVER_PORT}/`; 
            try {
                //console.log(`Opening ${optimizationUrl} in your default web browser...`);
                await open(optimizationUrl, {wait: false}); 
                console.log("\nA1 Evo should now be open in your browser.");
                console.log("Complete the optimization steps there according to browser screen instructions.");
                console.log("You can return here to transfer calibration or exit when finished.");
            } catch (error) {
                console.error(`\nError opening browser: ${error.message}`);
                console.error("Please manually open your browser to:", optimizationUrl);
            } finally {
                await mainMenu();
            }
            break;
        case 'transfer':
            if (!cachedAvrConfig || !cachedAvrConfig.ipAddress) {
                console.error(`\nError: Cannot transfer calibration. Configuration (${CONFIG_FILENAME}) is missing or invalid.`);
                console.warn("Please run Option 1 first.");
                await mainMenu();
                break;
            }
            console.log("\n--- Transfer Calibration ---");
            try {
                const targetIp = cachedAvrConfig.ipAddress;
                const scriptPath = path.join(__dirname, 'sendFilters.js');
                const nodePath = process.execPath;
                if (!fs.existsSync(scriptPath)) {
                    // This check might be redundant if pkg includes sendFilters.js, but doesn't hurt
                    throw new Error(`Required script 'sendFilters.js' not found at ${scriptPath}`);
                }
                console.log(`Executing calibration transfer for target IP: ${targetIp}`);
                console.log("-------------------------------------------------------------");

                // *** ADD APP_BASE_PATH as the third argument ***
                const args = [scriptPath, targetIp, APP_BASE_PATH];

                const child = spawn(nodePath, args, { stdio: 'inherit' });

                await new Promise((resolve, reject) => {
                    child.on('error', (spawnError) => {
                        console.error(`\n[main.js] Failed to start sendFilters.js: ${spawnError.message}`);
                        reject(spawnError);
                    });
                    child.on('close', (code) => {
                        console.log("-------------------------------------------------------------");
                        if (code === 0) {
                            console.log("Calibration transfer completed successfully!");
                            console.log("-------------------------------------------------------------");
                            resolve();
                        } else {
                            reject(new Error(`Filter transfer failed with exit code ${code}.`));
                        }
                    });
                });
            } catch (error) {
                console.error(`\n[main.js] Error during calibration transfer step: ${error.message}`);
            } finally {
                await mainMenu();
            }
            break;
        case 'exit':
            console.log('\nExiting application...');
            if (mainServer) {
                mainServer.close(() => {
                    console.log("Server stopped.");
                    process.exit(0);
                });
                setTimeout(() => {
                     console.log("Forcing exit...");
                     process.exit(1);
                }, 2000);
            } else {
                process.exit(0);
            }
            break; 
        default:
            console.log('Invalid choice. Please try again.');
            await mainMenu();
            break;
    }
}
async function initializeApp() {
    console.log('--------------------');
    console.log('  A1 Evo Acoustica  ');
    console.log('--------------------');
    mainServer = http.createServer((req, res) => {
        const url = req.url;
        const method = req.method;
        if (method === 'GET' && (url === '/' || url === `/${HTML_FILENAME}`)) {
            fs.readFile(HTML_FILEPATH, (err, data) => {
                if (err) {
                    console.error(`[Server] Error reading ${HTML_FILENAME}:`, err);
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Internal Server Error: Could not load main HTML file.');
                } else {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(data);
                }
            });
        } else if (method === 'GET' && url === `/${CONFIG_FILENAME}`) {
             if (cachedAvrConfig) {
                 res.writeHead(200, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify(cachedAvrConfig));
             } else {
                 fs.readFile(CONFIG_FILEPATH, (err, data) => {
                    if (err) {
                        console.warn(`[Server] ${CONFIG_FILENAME} requested but not found or not cached.`);
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `${CONFIG_FILENAME} not found. Run configuration first.` }));
                    } else {
                         try {
                            JSON.parse(data.toString());
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(data);
                         } catch(parseErr) {
                             console.error(`[Server] Error parsing ${CONFIG_FILENAME} from disk:`, parseErr);
                             res.writeHead(500, { 'Content-Type': 'application/json' });
                             res.end(JSON.stringify({ error: `Error reading configuration file.` }));
                         }
                    }
                });
             }
        } else if (method === 'GET' && req.url === '/api/get-app-path') {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ appPath: APP_BASE_PATH }));
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    });
    mainServer.listen(SERVER_PORT, 'localhost', () => {
        console.log(`Base path for files: ${APP_BASE_PATH}`);
        mainMenu(); 
    });
    mainServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`\nFATAL ERROR: Port ${SERVER_PORT} is already in use.`);
            console.error("Please close the application using the port (maybe another instance of this app?) or change SERVER_PORT in main.js.");
        } else {
            console.error('\nFATAL SERVER ERROR:', err);
        }
        process.exit(1); 
    });
}
function isProcessRunning(processName) {
    return new Promise((resolve) => {
        const platform = os.platform();
        let cmd = '';
        if (platform === 'win32') {
            cmd = `tasklist /FI "IMAGENAME eq ${processName}" /NH`;
        } else if (platform === 'darwin') {
            const escapedName = processName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\__STRING_304__');
            cmd = `pgrep -fli "${escapedName}"`; 
        } else { 
            const escapedName = processName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\__STRING_306__');
            cmd = `pgrep -fli "${escapedName}"`;
        }
        exec(cmd, (error, stdout, stderr) => {
            if (platform === 'win32') {
                resolve(stdout.toLowerCase().includes(processName.toLowerCase()));
            } else { 
                if (error) {
                    resolve(false); 
                } else {
                    resolve(stdout.trim().length > 0); 
                }
            }
        });
    });
}
function findRewPath() {
    const platform = os.platform();
    const commonPaths = [];
    if (platform === 'win32') {
        const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        commonPaths.push(path.join(progFiles, 'REW', 'roomeqwizard.exe'));
        commonPaths.push(path.join(progFilesX86, 'REW', 'roomeqwizard.exe'));
    } else if (platform === 'darwin') {
        commonPaths.push('/Applications/REW.app/Contents/MacOS/roomeqwizard'); 
        commonPaths.push('/Applications/REW.app');
        commonPaths.push('/Applications/REW/REW.app/Contents/MacOS/JavaApplicationStub');
        commonPaths.push('/Applications/REW/REW.app');
        const home = os.homedir();
        commonPaths.push(path.join(home, 'Applications/REW.app/Contents/MacOS/roomeqwizard'));
        commonPaths.push(path.join(home, 'Applications/REW.app'));
        commonPaths.push(path.join('Applications/REW/REW.app/Contents/MacOS/JavaApplicationStub'));
        commonPaths.push(path.join(home, 'Applications/REW/REW.app'));
    } else { 
        console.warn("Automatic REW path detection on Linux is limited. Checking common PATH locations.");
        return 'roomeqwizard';
    }
    //console.log("Checking common REW installation paths...");
    for (const p of commonPaths) {
        if (fs.existsSync(p)) {
             if (platform === 'darwin') {
                  if (p.endsWith('.app')) {
                      console.log(`Found REW application bundle: ${p}`);
                      return p; 
                  } else if (fs.existsSync(p.replace('/Contents/MacOS/roomeqwizard', ''))) { 
                      const appPath = p.replace('/Contents/MacOS/roomeqwizard', '');
                      console.log(`Found REW, using corresponding bundle: ${appPath}`);
                      return appPath; 
                  } else {
                      console.log(`Found REW directly: ${p}`);
                      return p; 
                  }
             } else { 
                console.log(`Found REW: ${p}`);
                return p; 
             }
        }
    }
    if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
        console.log("REW not found in common paths. Assuming 'roomeqwizard' is in PATH.");
        return 'roomeqwizard'; 
    }
    console.log("REW not found in standard locations.");
    return null; 
}
function launchRew(rewPath, memoryArg = "-Xmx4096m") { 
    return new Promise((resolve) => {
        const platform = os.platform();
        let cmd = '';
        let args = [];
        const apiArg = '-api'; 
        console.log(`Attempting to launch REW with 4GB allocated RAM and API server enabled from: ${rewPath}`);
        try {
            if (platform === 'win32') {
                cmd = `"${rewPath}"`; 
                args = [memoryArg, apiArg];
                 const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: true });
                 child.on('error', (err) => {
                    console.error(`Error launching REW (Win32): ${err.message}`);
                    resolve(false); 
                 });
                 child.unref(); 
                 //console.log("REW launch command executed (Win32).");
                 resolve(true); 
            } else if (platform === 'darwin') {
                 if (rewPath.endsWith('.app')) {
                    cmd = 'open';
                    args = ['-a', rewPath, '--args', memoryArg, apiArg];
                 } else {
                     cmd = rewPath; 
                     args = [memoryArg, apiArg];
                 }
                  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' }); 
                  child.on('error', (err) => {
                    console.error(`Error launching REW (macOS): ${err.message}`);
                    resolve(false);
                  });
                  child.unref();
                  //console.log("REW launch command executed (macOS).");
                  resolve(true);
            } else { 
                cmd = rewPath; 
                args = [memoryArg, apiArg];
                 const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
                 child.on('error', (err) => {
                    console.error(`Error launching REW (Linux/Other): ${err.message}`);
                    if (err.code === 'ENOENT') {
                         console.error(`Hint: Ensure '${rewPath}' is executable and in your system's PATH.`);
                    }
                    resolve(false);
                 });
                 child.unref();
                 //console.log("REW launch command executed (Linux/Other).");
                 resolve(true);
            }
        } catch (err) {
             console.error(`Exception trying to launch REW: ${err.message}`);
             resolve(false);
        }
    });
}
function checkRewApi(port = rewApiPort, timeout = 2000) {
    return new Promise((resolve) => {
        const options = {
            hostname: '127.0.0.1', 
            port: port,
            path: '/version',
            method: 'GET',
            timeout: timeout,
        };
        const req = http.request(options, (res) => {
            let responseBody = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { responseBody += chunk; });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(true);
                } else {
                    console.warn(`[checkRewApi] Failed: Received status code ${res.statusCode}.`);
                    resolve(false);
                }
            });
        });
        req.on('error', (err) => {
             if (err.code === 'ECONNREFUSED') {
                 console.warn(`[checkRewApi] Failed: Connection refused on port ${port} at 127.0.0.1.`);
             } else {
                 console.warn(`[checkRewApi] Failed: Network error - ${err.message} (Code: ${err.code})`);
             }
             resolve(false);
        });
        req.on('timeout', () => {
             console.warn(`[checkRewApi] Failed: Request timed out after ${timeout}ms.`);
             req.destroy();
             resolve(false);
        });
        req.end();
    });
}
async function ensureRewReady() {
    //console.log("\n--- Checking REW Status & API Availability ---");
    const platform = os.platform();
    const procNameBase = platform === 'win32' ? 'roomeqwizard.exe' : 'REW'; 
    console.log(`Checking if REW (${procNameBase}) is running...`);
    let isRunning = await isProcessRunning(procNameBase); 
    if (!isRunning && platform === 'darwin') {
        console.log("REW process not found, checking for Java process running REW...");
        isRunning = await isProcessRunning("java.*roomeqwizard"); 
    }
    //console.log(`Is REW process running? ${isRunning}`);
    let isApiListening = false;
    if (isRunning) {
        console.log(`REW process detected. Checking API status on port ${rewApiPort}...`);
        isApiListening = await checkRewApi(rewApiPort); 
        if (!isApiListening) {
        }
    }
    if (isRunning && isApiListening) {
        console.log("REW is running and its API server responded successfully. Good to go!");
        return true; 
    }
    if (isRunning && !isApiListening) {
        console.warn(`REW process is running, but the API on port ${rewApiPort} did not respond correctly.`);
        console.warn("Possible reasons: REW is still starting up, API server is disabled (needs '-api' launch flag or setting), firewall blocking, or different API port configured in REW.");
         const { proceedAnyway } = await inquirer.prompt([{
             type: 'confirm',
             name: 'proceedAnyway',
             message: `REW seems running, but the API isn't ready. Continue to open A1 Evo anyway? (May not function correctly without REW API)`,
             default: false 
         }]);
         return proceedAnyway; 
    }
    console.log("REW is not running.");
    const rewPath = findRewPath(); 
    if (!rewPath) {
        console.error("Could not automatically find REW installation in common locations.");
        console.log(`Please start REW manually.`);
        console.log("IMPORTANT: Ensure REW's API server is enabled.");
         const { proceedManual } = await inquirer.prompt([{
             type: 'confirm',
             name: 'proceedManual',
             message: `Could not find REW automatically. Please start it manually and start its API server.\nProceed to open A1 Evo once REW is ready?`,
             default: true
         }]);
        return proceedManual;
    }
    const { launchChoice } = await inquirer.prompt([{
        type: 'confirm',
        name: 'launchChoice',
        message: `Found REW at "${rewPath}". Attempt to launch it now with the API enabled?`,
        default: true
    }]);
    if (!launchChoice) {
        console.log("User chose not to launch REW automatically. Please start it manually with the API enabled.");
        const { proceedAfterManual } = await inquirer.prompt([{
             type: 'confirm',
             name: 'proceedAfterManual',
             message: `Proceed to open A1 Evo once you believe REW is ready?`,
             default: true
         }]);
        return proceedAfterManual;
    }
    const memoryArg = "-Xmx4096m"; 
    const launchInitiated = await launchRew(rewPath, memoryArg);
    if (!launchInitiated) {
        console.error("Failed to execute the REW launch command.");
        console.log("Please try starting REW manually with the API enabled.");
         const { proceedError } = await inquirer.prompt([{
             type: 'confirm',
             name: 'proceedError',
             message: `Failed to start REW automatically. Please start it manually with API enabled.\nProceed to open A1 Evo once REW is ready?`,
             default: true
         }]);
        return proceedError;
    }
    const waitTime = 8000; 
    console.log(`REW is launching. Waiting ${waitTime / 1000} seconds for REW and its API server to initialize...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    console.log("Checking REW API status again after launch attempt...");
    const isApiListeningAfterLaunch = await checkRewApi(rewApiPort);
    if (isApiListeningAfterLaunch) {
        console.log("REW launched and API server responded successfully. Proceeding...");
        return true; 
    } else {
        console.error(`Launched REW, but the API on port ${rewApiPort} did not respond correctly within the wait time.`);
         const { proceedFail } = await inquirer.prompt([{
             type: 'confirm',
             name: 'proceedFail',
             message: `Started REW, but couldn't confirm API status on port ${rewApiPort}.\nContinue to open A1 Evo anyway? (May not function correctly)`,
             default: false 
         }]);
        return proceedFail;
    }
}
process.on('SIGINT', () => {
    console.log("\nCtrl+C detected. Shutting down...");
    if (mainServer) {
        mainServer.close(() => {
            console.log("Server closed.");
            process.exit(0);
        });
        setTimeout(() => {
             console.log("Server close timed out. Forcing exit.");
             process.exit(1);
        }, 2000);
    } else {
        process.exit(0);
    }
});

initializeApp();
