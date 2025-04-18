const os = require('os');
const inquirer = require('inquirer');
const { spawn, exec } = require('child_process'); 
const open = require('open');
const http = require('http');
const dgram = require('dgram');
const net = require('net');
const { URL } = require('url');
const path = require('path');
const fs = require('fs');

const SERVER_PORT = 3000; 
const AVR_CONTROL_PORT = 1256;
const CONFIG = {timeouts: {discovery: 5000, connection: 3000, command: 5000}};
const rewApiPort = 4735;

let cachedAvrConfig = null;
let receivedOptimizationData = null;
let mainServer = null;

function getBasePath() {
  if (process.pkg) {
    return path.dirname(process.execPath);
  } else {
    return __dirname;
  }
}

const APP_BASE_PATH = getBasePath();
const CONFIG_FILENAME = 'receiver_config.avr';
const CONFIG_FILEPATH = path.join(APP_BASE_PATH, CONFIG_FILENAME);
const HTML_FILENAME = 'A1Evo.html';
const HTML_FILEPATH = path.resolve(__dirname, HTML_FILENAME);

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
        this.SEARCH_TARGETS = ['ssdp:all', 'upnp:rootdevice'];
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
                            console.log('Discovery socket closed.');
                            resolve(Array.from(devices.values()));
                         });
                    } else {
                         console.log('Discovery socket already closed or not bound.');
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
                                     console.log(`Found potential device: ${deviceInfo.manufacturer} ${deviceInfo.modelName} at ${rinfo.address}`);
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
                    console.log(`Searching ${this.SSDP_MULTICAST_ADDR}:${this.SSDP_PORT}...`);
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
                        resolve({
                            modelName: modelNameMatch ? modelNameMatch[1].trim() : 'Unknown Model',
                            manufacturer: manufacturerMatch ? manufacturerMatch[1].trim() : 'Unknown Manufacturer',
                            friendlyName: friendlyNameMatch ? friendlyNameMatch[1].trim() : 'Unknown Device',
                            descriptionUrl: locationUrl
                        });
                    } catch (error) {
                        console.error("Error parsing device description XML:", error, "\nXML Data:", data.substring(0, 500)); 
                        
                        resolve({ modelName: 'Unknown Model', manufacturer: 'Unknown Manufacturer', friendlyName: 'Unknown Device', descriptionUrl: locationUrl });
                    }
                });
            });
            req.on('error', (e) => {
                 console.error(`Error requesting description ${locationUrl}: ${e.message}`);
                 
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
            name: `[${index + 1}] ${device.friendlyName} (${device.manufacturer} ${device.modelName}) - ${device.address}`,
            value: index 
        }));
        choices.push(new inquirer.Separator());
        choices.push({ name: 'Cancel', value: -1 });
        const answers = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedDeviceIndex',
                message: 'Multiple AVRs found. Select the target device:',
                choices: choices,
                pageSize: 15 
            }
        ]);
        if (answers.selectedDeviceIndex === -1) {
            console.log("Device selection cancelled.");
            return null;
        }
        return devices[answers.selectedDeviceIndex];
    }
}

async function connectToAVR(ip, port, timeout) {
  return new Promise((resolve, reject) => {
    console.log(`Attempting to connect to ${ip}:${port}...`);
    const client = net.createConnection({ port, host: ip, timeout });
    const connectionTimeout = setTimeout(() => {
         client.destroy(); 
         reject(new Error(`Connection timed out after ${timeout}ms.`));
     }, timeout);
    client.once('connect', () => {
      clearTimeout(connectionTimeout);
      client.removeAllListeners('error');
      client.removeAllListeners('timeout');
      console.log(`Successfully connected to ${ip}:${port}.`);
      resolve(client);
    });
    client.once('error', err => {
      clearTimeout(connectionTimeout);
      console.error(`Connection error to ${ip}:${port}: ${err.message}`);
      reject(new Error(`Connection error: ${err.message}`));
    });
  });
}

async function getAvrInfoAndStatus(socket, commandTimeout) {
  const sendRawAndParseJson = (hexWithChecksum, label) =>
    new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const packet = Buffer.from(hexWithChecksum, 'hex');
      let timer;
      const cleanup = (error = null) => {
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        clearTimeout(timer);
        if (error) reject(error);
      };
      const onData = data => {
        buffer = Buffer.concat([buffer, data]);
        const utf8 = buffer.toString('utf8');
        const jsonStart = utf8.indexOf('{');
        const jsonEnd = utf8.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
          try {
            const potentialJson = utf8.slice(jsonStart, jsonEnd + 1);
            const parsed = JSON.parse(potentialJson);
            //console.log(`Successfully parsed response for ${label}.`);
            cleanup();
            resolve(parsed);
          } catch (err) { } 
        }
        if (buffer.length > 1 * 1024 * 1024) {
             cleanup(new Error(`${label} response buffer exceeded 1MB without valid JSON.`));
         }
      };
      const onError = err => {
        console.error(`Socket error during ${label}: ${err.message}`);
        cleanup(new Error(`Socket error during ${label}: ${err.message}`));
      };
      timer = setTimeout(() => {
        console.error(`${label} timed out waiting for JSON response.`);
        cleanup(new Error(`${label} timed out waiting for JSON response.`));
      }, commandTimeout);
      socket.on('data', onData);
      socket.on('error', onError);
      //console.log(`Sending command: ${label}...`);
      socket.write(packet, err => {
        if (err) {
          console.error(`Write error during ${label}: ${err.message}`);
          cleanup(new Error(`Write error during ${label}: ${err.message}`));
        }
      });
    });
  try {
    //console.log("Requesting AVR Information (GET_AVRINF)...");
    const infoJson = await sendRawAndParseJson('54001300004745545f415652494e460000006c', 'GET_AVRINF');
    //console.log("Requesting AVR Status (GET_AVRSTS)...");
    const statusJson = await sendRawAndParseJson('54001300004745545f41565253545300000089', 'GET_AVRSTS');
    const reportedDType = infoJson?.DType ?? null;
    let activeChannels = [];
    let rawChSetup = [];
    if (statusJson?.ChSetup && Array.isArray(statusJson.ChSetup)) {
      rawChSetup = statusJson.ChSetup;
      activeChannels = statusJson.ChSetup
        .filter(entry => entry && typeof entry === 'object' && Object.values(entry)[0] !== 'N')
        .map(entry => Object.keys(entry)[0]);
      console.log(`Detected Active Channels: ${activeChannels.join(', ')}`);
    } else {
      console.warn("ChSetup is missing or invalid in AVR status response. Active channels may be incomplete.");
    }
    const details = {
        ip: socket.remoteAddress, 
        activeChannels,
        infoJson: infoJson,
        avrStatus: statusJson,
        rawChSetup
    };
    return details;
  } catch (error) {
     console.error("Failed to get full AVR info/status:", error);
     throw error;
  }
}

function formatDataForFrontend_old(details) {
    const infoJson = details.infoJson || {};
    const statusJson = details.avrStatus || {};
    const targetModelName = infoJson.ModelName || details.modelName;
    if (!targetModelName || targetModelName === 'Unknown') {
        throw new Error("Could not determine AVR Model Name.");
    }
    const ipAddress = details.ip;
    if (!ipAddress) {
        throw new Error("Could not determine AVR IP Address.");
    }
    let enMultEQType = null;
    const audysseyInfoString = infoJson.EQType || infoJson.Audyssey?.Version || infoJson.Audyssey?.TypeString || infoJson.MultEQ?.Version || "";
    if (typeof audysseyInfoString === 'string' && audysseyInfoString) {
        if (audysseyInfoString.includes('XT32')) enMultEQType = 2;
        else if (audysseyInfoString.includes('XT')) enMultEQType = 1;
        else if (audysseyInfoString.includes('MultEQ')) enMultEQType = 0;
    }
    if (enMultEQType === null) {
        console.warn("Audyssey/EQ type string not found or recognized in AVRINF response:", infoJson);
        throw new Error("Could not determine MultEQ Type.");
    }
    const ampAssignString = statusJson.AmpAssign;
    if (!ampAssignString || typeof ampAssignString !== 'string') {
         console.warn("AmpAssign string not found in AVRSTS response:", statusJson);
        throw new Error("Could not determine Amp Assign type string.");
    }
    const ampAssignInfo = statusJson.AssignBin;
    if (!ampAssignInfo || typeof ampAssignInfo !== 'string' || ampAssignInfo.length < 10) {
        console.warn("Could not find valid AssignBin (ampAssignInfo) in AVRSTS response:", statusJson);
        throw new Error("Could not determine Amp Assign Info (AssignBin).");
    }
    let detectedChannels = [];
    let subCount = 0;
    const rawChSetup = details.rawChSetup;
    if (!rawChSetup || !Array.isArray(rawChSetup) || rawChSetup.length === 0) {
        console.warn("Channel Setup (ChSetup) data is missing or empty:", statusJson);
        throw new Error("Could not determine Channel Setup (detectedChannels).");
    }
    rawChSetup.forEach(entry => {
        if (!entry || typeof entry !== 'object') return;
        let commandId = Object.keys(entry)[0];
        const speakerType = entry[commandId];
        if (speakerType !== 'N') {
            if (commandId.startsWith('SWMIX')) commandId = commandId.replace('MIX', '');
            detectedChannels.push({ commandId: commandId });
            if (commandId.startsWith('SW') || commandId.startsWith('LFE')) subCount++;
        }
    });
    if (detectedChannels.length === 0) {
        console.warn("No active channels found in Channel Setup (all might be 'N'?).");
        throw new Error("No active channels found in Channel Setup.");
    }
    const simplifiedConfig = {
        targetModelName: targetModelName,
        ipAddress: ipAddress,
        enMultEQType: enMultEQType,
        subwooferNum: subCount,
        ampAssign: ampAssignString,
        ampAssignInfo: ampAssignInfo,
        detectedChannels: detectedChannels
    };
    return simplifiedConfig;
}

function formatDataForFrontend(details) { // details contains modelName, ip, ampAssignString, assignBin, eqTypeString, rawChSetup etc.
    // ... (Keep the last version of this function, it should work with the 'details' structure above) ...
     const targetModelName = details.modelName || 'Unknown';
     const ipAddress = details.ip || null;
     const eqTypeString = details.eqTypeString || "";
     const ampAssignString = details.ampAssignString;
     const assignBin = details.assignBin;
     const rawChSetup = details.rawChSetup;

     let enMultEQType = null;
      if (typeof eqTypeString === 'string' && eqTypeString) {
         if (eqTypeString.includes('XT32')) enMultEQType = 2;
         else if (eqTypeString.includes('XT')) enMultEQType = 1;
         else if (eqTypeString.includes('MultEQ')) enMultEQType = 0;
      }
      if (enMultEQType === null) { throw new Error("Could not determine MultEQ Type from provided string."); }
      if (!ampAssignString) throw new Error("Amp Assign string missing.");
      if (!assignBin) throw new Error("Amp Assign Info (AssignBin) missing.");
      if (!rawChSetup || !Array.isArray(rawChSetup)) { throw new Error("Channel Setup data missing or invalid."); }

      let detectedChannels = [];
      let subCount = 0;
      rawChSetup.forEach(entry => {
          if (!entry || typeof entry !== 'object') return;
          let commandId = Object.keys(entry)[0];
          const speakerType = entry[commandId];
          if (speakerType !== 'N') {
              if (commandId.startsWith('SWMIX')) commandId = commandId.replace('MIX', '');
              detectedChannels.push({ commandId: commandId });
              if (commandId.startsWith('SW') || commandId.startsWith('LFE')) subCount++;
          }
      });
      if (detectedChannels.length === 0) { throw new Error("No active channels found."); }

     const simplifiedConfig = {
         targetModelName: targetModelName,
         ipAddress: ipAddress,
         enMultEQType: enMultEQType,
         subwooferNum: subCount,
         ampAssign: ampAssignString,
         ampAssignInfo: assignBin,
         detectedChannels: detectedChannels
     };
     return simplifiedConfig;
}
async function fetchModelFromGoform(ipAddress) { // Make async for await
    return new Promise((resolve) => {
        const url = `http://${ipAddress}/goform/formMainZone_MainZoneXml.xml`;
        console.log(`Attempting to fetch model name from ${url}...`);
        const options = {
            method: 'GET',
            timeout: CONFIG.timeouts.command // Reuse command timeout
        };

        const req = http.request(options, (res) => {
            let data = '';
            if (res.statusCode !== 200) {
                console.warn(`Failed to get ${url}. Status: ${res.statusCode}`);
                res.resume();
                resolve(null); // Cannot get model this way
                return;
            }
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    // Look for ModelName within <value> tags
                    const modelMatch = data.match(/<ModelName><value>(.*?)<\/value><\/ModelName>/i);
                    // Also try FriendlyName as a fallback? Sometimes it's better populated.
                    const friendlyMatch = data.match(/<FriendlyName><value>(.*?)<\/value><\/FriendlyName>/i);

                    let modelName = modelMatch ? modelMatch[1].trim() : null;
                    const friendlyName = friendlyMatch ? friendlyMatch[1].trim() : null;

                    // Prefer ModelName, but use FriendlyName if ModelName is absent/generic
                    if (!modelName || modelName.toLowerCase().includes('receiver') || modelName.toLowerCase().includes('avr')) {
                       if (friendlyName && friendlyName.length > 2) { // Use friendly name if model is generic/missing and friendly exists
                           console.log(`Using FriendlyName ("${friendlyName}") as model name from goform.`);
                           modelName = friendlyName;
                       }
                    }

                    console.log(`Model name found via goform: ${modelName}`);
                    resolve(modelName); // Return the determined name (could still be null)
                } catch (parseError) {
                    console.error(`Error parsing XML from ${url}:`, parseError);
                    resolve(null);
                }
            });
        });

        req.on('error', (e) => {
            console.error(`Error requesting ${url}: ${e.message}`);
            resolve(null);
        });
        req.on('timeout', () => {
            req.destroy();
            console.error(`Timeout requesting ${url}`);
            resolve(null);
        });
        req.end();
    });
}


async function runFullDiscoveryAndSave_old(interactive = true) { // Default to interactive for Option 1
    console.log('\nStarting AVR discovery and configuration...');
    let targetIp = null;
    let modelName = null;
    let initialFriendlyName = null; // Store initial UPnP friendly name if found
    let modelSource = "None";
    let avrFoundViaDiscovery = false;
    let selectedAvrInfo = null; // To store the full device object from discovery

    // --- Stage 1: Try UPnP Discovery ---
    try {
        const discovery = new UPNPDiscovery(CONFIG.timeouts.discovery);
        let devices = await discovery.discover();
        console.log(`Discovery finished. Found ${devices.length} distinct UPnP device descriptions.`);

        // Filter based on D+M keywords in description (our original working filter)
        const potentialAvrs = devices.filter(dev =>
             dev.modelName && dev.modelName !== 'Unknown Model' &&
             (/Denon|Marantz/i.test(dev.manufacturer || '') ||
             /AVR|Receiver|SR|NR|AV|Cinema/i.test(dev.friendlyName || '') ||
             /AVR|SR|NR|AV|Cinema/i.test(dev.modelName || ''))
        );
        console.log(`Found ${potentialAvrs.length} potential Denon/Marantz descriptions via UPnP.`);

        if (potentialAvrs.length === 1) {
            selectedAvrInfo = potentialAvrs[0];
        } else if (potentialAvrs.length > 1 && interactive) {
            console.warn(`Multiple potential Denon/Marantz descriptions found via UPnP.`);
            selectedAvrInfo = await UPNPDiscovery.interactiveDeviceSelection(potentialAvrs);
        } else if (potentialAvrs.length > 1 && !interactive) {
             console.log("Multiple potential UPnP devices found. Cannot auto-select.");
             // Don't fail yet, maybe manual IP or goform will work
        }
        // else: 0 potential AVRs found via UPnP description filtering

        if (selectedAvrInfo) {
            avrFoundViaDiscovery = true;
            targetIp = selectedAvrInfo.address;
            modelName = selectedAvrInfo.modelName; // Get model name from description
            initialFriendlyName = selectedAvrInfo.friendlyName;
            modelSource = "UPnP Description XML";
            console.log(`Using device found via UPnP: ${modelName} at ${targetIp}`);
        } else {
            console.log("No suitable device description found via UPnP filtering.");
            // Continue to potentially try manual IP or goform
        }

    } catch (discoveryError) {
        console.error(`Error during UPnP discovery: ${discoveryError.message}`);
        // Continue, maybe manual IP will work
    }


    // --- Stage 2: Manual IP Entry (If UPnP failed and interactive) ---
    if (!targetIp && interactive) {
        console.log("\nUPnP discovery did not yield a target device.");
        try {
            const ipAnswer = await inquirer.prompt([{
                type: 'input',
                name: 'manualIp',
                message: 'Please enter the AVR IP address manually:',
                validate: input => (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input)) ? true : 'Please enter a valid IPv4 address.'
            }]);
            targetIp = ipAnswer.manualIp;
            console.log(`Using manually entered IP: ${targetIp}`);
        } catch (promptError) {
             console.error("Failed to get manual IP input.", promptError);
             return false; // Abort if prompt fails
        }
    } else if (!targetIp && !interactive) {
         console.error("Automatic check failed: No AVR found via UPnP and cannot prompt for IP.");
         return false;
    }
    if (!targetIp) { console.error("Configuration aborted: No target IP address available."); return false; }


    // --- Stage 3: Try /goform/ XML (If model still unknown) ---
    if (!modelName || modelName === 'Unknown Model') {
        console.log(`Model name not found via UPnP. Trying /goform/ endpoint on ${targetIp}...`);
        const goformModel = await fetchModelFromGoform(targetIp);
        if (goformModel && goformModel !== 'Unknown Model') {
            modelName = goformModel;
            modelSource = "/goform/ XML";
            console.log(`Model name identified as "${modelName}" via /goform/.`);
        } else {
            console.log("Could not get model name from /goform/ endpoint either.");
            modelSource = "None Found";
        }
    }


    // --- Stage 4: Manual Model Name (If still needed and interactive) ---
    let finalModelName = modelName;
    if (interactive) {
        let promptForModel = false;
        if (finalModelName && finalModelName !== 'Unknown Model') {
            const confirm = await inquirer.prompt([{ /* ... confirm prompt ... */
                type: 'confirm',
                name: 'isCorrect',
                message: `Is "${finalModelName}" the correct model for the device at ${targetIp}? (Source: ${modelSource})`,
                default: true
            }]);
            if (!confirm.isCorrect) { finalModelName = null; promptForModel = true; }
        } else {
            promptForModel = true; // No model found automatically
        }

        if (promptForModel) {
            console.log("\nCould not automatically determine/confirm model name.");
            const modelPrompt = await inquirer.prompt([/* ... manual input ... */{
                type: 'input', name: 'modelNameManual',
                message: 'Please enter the correct AVR Model Name (e.g., SR6011, X3800H):',
                validate: input => (input && input.trim().length > 0) ? true : 'Model name cannot be empty.'
            }]);
            finalModelName = modelPrompt.modelNameManual.trim();
        }
    } else { // Non-interactive
         if (!finalModelName || finalModelName === 'Unknown Model') {
             console.error("Automatic check failed: Could not determine AVR Model Name.");
             return false;
         }
         console.log(`Using automatically determined model name: "${finalModelName}"`);
    }
    if (!finalModelName || finalModelName === 'Unknown Model') { // Final check
        console.error("Configuration aborted: Final Model Name could not be determined.");
        return false;
    }


    // --- Stage 5: Connect & Get Status (operational data) ---
    let socket;
    let avrOperationalData = null;
    try {
        socket = await connectToAVR(targetIp, AVR_CONTROL_PORT, CONFIG.timeouts.connection);
        console.log(`Connected to ${targetIp}. Fetching operational status...`);
        avrOperationalData = await getAvrInfoAndStatus(socket, CONFIG.timeouts.command);
    } catch (err) { /* ... */ return false; }
    finally { if (socket && !socket.destroyed) socket.end(); console.log(`Connection to ${targetIp} closed.`); }


    // --- Stage 6: Format and Save ---
    try {
       const finalDetails = {
           ...avrOperationalData, // Has ip, rawChSetup, ampAssignString, assignBin, eqTypeString
           modelName: finalModelName,
           manufacturer: selectedAvrInfo?.manufacturer || '', // From UPnP if available
           friendlyName: selectedAvrInfo?.friendlyName || '', // From UPnP if available
       };
       const frontendData = formatDataForFrontend(finalDetails);
       console.log(`\nSaving configuration to ${CONFIG_FILENAME} for model "${frontendData.targetModelName}"...`);
       fs.writeFileSync(CONFIG_FILEPATH, JSON.stringify(frontendData, null, 2));
       console.log('Configuration saved successfully.');
       cachedAvrConfig = frontendData;
       return true;
    } catch (formatSaveError) { /* ... */ return false; }
}

// Inside main.js

async function runFullDiscoveryAndSave(interactive = true) {
    console.log('\nStarting AVR discovery...');
    const discovery = new UPNPDiscovery(CONFIG.timeouts.discovery);
    let devices = [];
    try {
        devices = await discovery.discover();
        console.log(`Discovery finished. Found ${devices.length} distinct UPnP device descriptions.`);
        // console.log("DEBUG: All discovered device descriptions:", JSON.stringify(devices, null, 2));
    } catch (error) { /* ... error handling ... */ return false; }

    // --- Filter based on Keywords ---
    const potentialAvrs = devices.filter(dev =>
         dev.modelName && dev.modelName !== 'Unknown Model' && // Must have a model name attempt
         (/Denon|Marantz/i.test(dev.manufacturer || '') ||
         /AVR|Receiver|SR|NR|AV|Cinema/i.test(dev.friendlyName || '') ||
         /AVR|SR|NR|AV|Cinema/i.test(dev.modelName || ''))
    );
    console.log(`Found ${potentialAvrs.length} potential Denon/Marantz descriptions after filtering.`);

    // --- Group by IP Address ---
    const groupedByIp = potentialAvrs.reduce((acc, device) => {
      const ip = device.address;
      if (!acc[ip]) {
        acc[ip] = []; // Initialize array for this IP
      }
      acc[ip].push(device); // Add device to this IP group
      return acc;
    }, {}); // Start with an empty object

    const uniqueIPs = Object.keys(groupedByIp);
    console.log(`Found ${uniqueIPs.length} unique IP address(es) for potential AVRs.`);

    // --- Selection Logic based on Unique IPs ---
    let targetIp = null;
    let modelName = null; // Model name from selected description
    let initialFriendlyName = null;
    let modelSource = "None";
    let selectedAvrInfo = null; // Store the chosen device object

    if (uniqueIPs.length === 0) {
        console.log('No suitable Denon/Marantz devices identified.');
        // Proceed to manual IP entry if interactive
    } else if (uniqueIPs.length === 1) {
        targetIp = uniqueIPs[0];
        // Choose the 'best' description from this single IP group
        // Prioritize entries with non-generic model names or non-empty friendly names
        const descriptionsForIp = groupedByIp[targetIp];
        selectedAvrInfo = descriptionsForIp.find(d => d.modelName && !/DigitalMediaAdapter|MediaRenderer/i.test(d.modelName)) || // Prefer non-generic model
                         descriptionsForIp.find(d => d.friendlyName) || // Then prefer one with friendly name
                         descriptionsForIp[0]; // Otherwise just take the first one
        modelName = selectedAvrInfo.modelName;
        initialFriendlyName = selectedAvrInfo.friendlyName;
        modelSource = "UPnP Description XML";
        console.log(`Automatically selected single potential AVR at ${targetIp} (reported as: ${selectedAvrInfo.manufacturer}/${modelName})`);
    } else {
        // Multiple distinct IPs found
        if (!interactive) {
            console.log("Multiple potential AVR IPs found. Cannot auto-select.");
            // Fail non-interactive check here? Or proceed without IP? Let's fail.
             return false;
        } else {
            console.warn(`Multiple potential AVRs found at different IP addresses.`);
            // Create a list for the user to choose from, one representative per IP
            const choicesForPrompt = uniqueIPs.map(ip => {
                // Select the 'best' description for this IP to display
                const descriptions = groupedByIp[ip];
                const representative = descriptions.find(d => d.modelName && !/DigitalMediaAdapter|MediaRenderer/i.test(d.modelName)) ||
                                      descriptions.find(d => d.friendlyName) ||
                                      descriptions[0];
                // Return the representative object for interactive selection
                return representative;
            });

            selectedAvrInfo = await UPNPDiscovery.interactiveDeviceSelection(choicesForPrompt); // Pass the de-duplicated list

            if (selectedAvrInfo) {
                targetIp = selectedAvrInfo.address;
                modelName = selectedAvrInfo.modelName;
                initialFriendlyName = selectedAvrInfo.friendlyName;
                modelSource = "UPnP Description XML (User Selection)";
                console.log(`User selected AVR: ${modelName} at ${targetIp}`);
            } else {
                console.log("No device selected by user.");
                // Proceed to manual IP entry
            }
        }
    }

    // --- Manual IP Entry (If needed and interactive) ---
    if (!targetIp && interactive) {
        console.log("\nNo AVR selected or found via UPnP.");
         try {
             const ipAnswer = await inquirer.prompt([{ /* ... manual IP prompt ... */ }]);
             targetIp = ipAnswer.manualIp;
             console.log(`Using manually entered IP: ${targetIp}`);
             modelSource = "Manual IP (Model Unknown)"; // Reset model source
             modelName = null; // Clear any previously guessed model name
             selectedAvrInfo = { address: targetIp }; // Create basic info object
         } catch (promptError) { /* ... */ return false; }
    } else if (!targetIp && !interactive) {
         console.error("Automatic check failed: No AVR identified.");
         return false;
    }
    if (!targetIp) { console.error("Configuration aborted: No target IP."); return false; }


    // --- Try /goform/ XML (If model still unknown) ---
    if (!modelName || modelName === 'Unknown Model') {
        console.log(`Model name unknown or invalid from UPnP. Trying /goform/ endpoint on ${targetIp}...`);
        const goformModel = await fetchModelFromGoform(targetIp); // This function needs targetIp
        if (goformModel && goformModel !== 'Unknown Model') {
            // *** Important: Only update modelName if goform provides something ***
            // *** Don't overwrite a potentially valid modelName from UPnP with null from goform ***
            modelName = goformModel;
            modelSource = "/goform/ XML";
            console.log(`Model name identified as "${modelName}" via /goform/.`);
        } else {
            console.log("Could not get model name from /goform/ endpoint.");
            if (modelSource !== "UPnP Description XML") modelSource = "None Found"; // Update source only if UPnP didn't provide one
        }
    }

    // --- Manual Model Name (If still needed and interactive) ---
    let finalModelName = modelName; // Use automatically found one if available
     if (interactive) {
         let promptForModel = false;
         if (finalModelName && finalModelName !== 'Unknown Model') {
             // Ask user to confirm the automatically found name
             const confirm = await inquirer.prompt([{ /* ... */
                 type: 'confirm',
                 name: 'isCorrect',
                 message: `Is "${finalModelName}" the correct model for device at ${targetIp}? (Source: ${modelSource})`,
                 default: true
             }]);
             if (!confirm.isCorrect) { finalModelName = null; promptForModel = true; }
         } else {
             promptForModel = true; // No model found automatically
         }
         if (promptForModel) {
            console.log("\nPlease manually enter the model name."); // Added context
            const modelPrompt = await inquirer.prompt([
               {
                 type: 'input',
                 name: 'modelNameManual', // Keep this name consistent
                 message: 'Please enter the correct AVR Model Name (e.g., SR6011, X3800H):',
                 validate: input => (input && input.trim().length > 0) ? true : 'Model name cannot be empty.'
                }
            ]);
            finalModelName = modelPrompt.modelNameManual.trim();
        }
     } else { /* ... non-interactive logic ... */
          if (!finalModelName || finalModelName === 'Unknown Model') { return false; }
     }
     if (!finalModelName || finalModelName === 'Unknown Model') { return false; }


    // --- Connect & Get Status ---
    // ... (Connect using targetIp, call getAvrInfoAndStatus) ...
    let socket;
    let avrOperationalData = null;
    try {
        socket = await connectToAVR(targetIp, AVR_CONTROL_PORT, CONFIG.timeouts.connection);
        console.log(`Connected to ${targetIp}. Reading configuration...`);
        avrOperationalData = await getAvrInfoAndStatus(socket, CONFIG.timeouts.command);
    } catch (err) { /* ... */ return false; }
    finally { if (socket && !socket.destroyed) socket.end(); console.log(`Connection to ${targetIp} closed.`); }


    // --- Format and Save ---
    try {
       const finalDetails = {
           ...avrOperationalData, // Has ip, rawChSetup, ampAssignString, assignBin, eqTypeString
           modelName: finalModelName,
           // Use manufacturer/friendlyName from the selected UPnP device *if* one was selected
           manufacturer: selectedAvrInfo?.manufacturer || '',
           friendlyName: selectedAvrInfo?.friendlyName || initialFriendlyName || '', // Use initial if selected one is bad
       };
       const frontendData = formatDataForFrontend(finalDetails);
       console.log(`\nSaving configuration to ${CONFIG_FILENAME} for model "${frontendData.targetModelName}"...`);
       fs.writeFileSync(CONFIG_FILEPATH, JSON.stringify(frontendData, null, 2));
       console.log('Configuration saved successfully.');
       cachedAvrConfig = frontendData;
       return true;
    } catch (formatSaveError) { /* ... */ return false; }
}

function loadConfigFromFile() {
    if (fs.existsSync(CONFIG_FILEPATH)) {
        try {
            console.log(`Loading configuration from ${CONFIG_FILENAME}...`);
            const fileContent = fs.readFileSync(CONFIG_FILEPATH, 'utf-8');
            cachedAvrConfig = JSON.parse(fileContent);
            console.log(`Configuration loaded for: ${cachedAvrConfig.targetModelName} at ${cachedAvrConfig.ipAddress || 'IP Unknown'}`);
            return true;
        } catch (error) {
            console.error(`Error reading or parsing ${CONFIG_FILENAME}: ${error.message}`);
            cachedAvrConfig = null;
           
            return false;
        }
    } else {
        console.log(`${CONFIG_FILENAME} not found.`);
        cachedAvrConfig = null;
        return false;
    }
}

async function mainMenu() {
    const configExists = fs.existsSync(CONFIG_FILEPATH);
    const configOptionName = configExists
        ? "1. Replace AVR configuration file"
        : "1. Create AVR configuration cile";
    const choices = [
        { name: configOptionName, value: 'config' },
        { name: '2. Start optimization (opens A1 Evo in your browser)', value: 'optimize' },
        { name: '3. Transfer calibration', value: 'transfer' },
        new inquirer.Separator(),
        { name: 'Exit', value: 'exit' },
    ];
    if (!configExists) { 
         choices[1].name += ' (requires config file)'; 
         choices[1].disabled = true;
         choices[2].name += ' (requires config file)'; 
         choices[2].disabled = true;
    }
    choices[2].name += ' (requires .oca calibration file)';
    
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
            await runFullDiscoveryAndSave(true);
            loadConfigFromFile(); 
            await mainMenu();
            break;
        case 'optimize':
            const rewReady = await ensureRewReady();
                if (!rewReady) {
                    console.warn("REW check failed or user chose not to proceed. Aborting optimization.");
                    await mainMenu(); 
                    break;
                }
            if (!fs.existsSync(CONFIG_FILEPATH)) {
                console.warn(`\nError: Configuration file '${CONFIG_FILENAME}' not found.`);
                console.warn("Please run Option 1 first.");
                await mainMenu();
                break;
            }
            if (!fs.existsSync(HTML_FILEPATH)) {
                console.error(`Error: ${HTML_FILENAME} not found! Cannot start optimization.`);
                await mainMenu();
                break;
            }
            console.log('\n--- Starting Optimization ---');
            const optimizationUrl = `http://localhost:${SERVER_PORT}/`;
            
            try {
                await open(optimizationUrl, {wait: false});
                console.log("A1 Evo is now opened in your web browser. Please complete the optimization process there!");
            } catch (error) {
                console.error(`Error opening browser: ${error.message}`);
            } finally {
                await mainMenu();
            }
            break;
        case 'transfer':
            if (!fs.existsSync(CONFIG_FILEPATH)) {
                console.error("\nError: Cannot transfer. Configuration file is missing.");
                 console.warn("Please run Option 1 first.");
                 await mainMenu();
                 break;
            }
             console.log("\n--- Transfer Calibration ---");
             //console.log("Running sendFilters.js to select file and transfer...");
             try {
                 loadConfigFromFile(); 
                 if (!cachedAvrConfig || !cachedAvrConfig.ipAddress) {
                     throw new Error(`IP Address not found in ${CONFIG_FILENAME}. Please re-run Option 1.`);
                 }
                 const targetIp = cachedAvrConfig.ipAddress;
                 const scriptPath = path.join(__dirname, 'sendFilters.js');
                 const nodePath = process.execPath;
                 //console.log(`\nExecuting sendFilters.js for target IP: ${targetIp}`);
                 //console.log("You will be prompted to select the .oca file by the script below:");
                 console.log("-------------------------------------------------------------");
                 const child = spawn(nodePath,
                                     [scriptPath, targetIp], 
                                     { stdio: 'inherit' }); 
                 await new Promise((resolve, reject) => {
                     child.on('error', (spawnError) => {
                         console.error(`\n[main.js] Failed to start sendFilters.js: ${spawnError.message}`);
                         reject(spawnError);
                     });
                     child.on('close', (code) => {
                         console.log("-------------------------------------------------------------");
                         console.log(`\n[main.js] sendFilters.js process exited with code ${code}.`);
                         if (code === 0) {
                             resolve(); 
                         } else {
                             
                             reject(new Error(`sendFilters.js exited with error code ${code}`));
                         }
                     });
                 });
                 console.log("Calibration transfer process finished!");
             } catch (error) {
                 console.error(`\n[main.js] Error during Transfer Calibration step: ${error.message}`);
             } finally {
                await mainMenu(); 
             }
            break; 
        case 'exit':
            console.log('Exiting application...');
            if (mainServer) {
                mainServer.close(() => console.log("Server stopped."));
            }
            process.exit(0);
            break;
        default:
            console.log('Invalid choice.');
            await mainMenu();
            break;
    }
}

async function initializeApp() {
    console.log('-------------------------');
    console.log('  A1 Evo Acoustica v1.0  ');
    console.log('-------------------------');
    loadConfigFromFile();
    mainServer = http.createServer((req, res) => {
        const url = req.url;
        //console.log(`Server received request: ${req.method} ${url}`); 
        if (url === '/' || url === `/${HTML_FILENAME}`) {
            fs.readFile(HTML_FILEPATH, (err, data) => {
                if (err) {
                    console.error(`Error reading ${HTML_FILENAME}:`, err);
                    res.writeHead(500);
                    res.end('Error loading HTML file.');
                } else {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(data);
                }
            });
        } else if (url === `/${CONFIG_FILENAME}`) {
             fs.readFile(CONFIG_FILEPATH, (err, data) => {
                if (err) {
                    console.warn(`${CONFIG_FILENAME} requested but not found on disk.`);
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `${CONFIG_FILENAME} not found. Run configuration first.` }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(data);
                }
            });
        }

        else if (req.url === '/api/get-app-path' && req.method === 'GET') {
            //console.log("Request received for /api/get-app-path");
            res.writeHead(200, {'Content-Type': 'application/json'});
            // Send the APP_BASE_PATH calculated at startup
            res.end(JSON.stringify({ appPath: APP_BASE_PATH }));
        }

        else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });
    mainServer.listen(SERVER_PORT, 'localhost', () => {
        //console.log(`\nPersistent server listening on http://localhost:${SERVER_PORT}`);
        if (!fs.existsSync(CONFIG_FILEPATH)) {
             console.warn(`\nWarning: ${CONFIG_FILENAME} not found. Please run Option 1.`);
        }
        mainMenu(); 
    });
    mainServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`Error: Port ${SERVER_PORT} is already in use. Close other apps or change SERVER_PORT.`);
        } else {
            console.error('Server error:', err);
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
            const simpleName = processName.replace('.exe','');
            cmd = `pgrep -fli "${simpleName}"`;
        } else {
            const simpleName = processName.replace('.exe','');
            cmd = `pgrep -fli "${simpleName}"`;
        }
        if (!cmd) {
             console.warn("Unsupported platform for checking running process:", platform);
            return resolve(false); 
        }
        exec(cmd, (error, stdout, stderr) => {
            if (error && platform !== 'win32') { 
                return resolve(false); 
            }
            if (stderr) {
            }
            if (platform === 'win32') {
                 resolve(stdout.toLowerCase().includes(processName.toLowerCase()));
            } else {
                 resolve(stdout.trim().length > 0); 
            }
        });
    });
}

function findRewPath() {
    const platform = os.platform();
    const commonPaths = [];
    if (platform === 'win32') {
        commonPaths.push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'REW', 'roomeqwizard.exe'));
        commonPaths.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'REW', 'roomeqwizard.exe'));
         
    } else if (platform === 'darwin') {
        commonPaths.push('/Applications/REW.app/Contents/MacOS/roomeqwizard'); 
        commonPaths.push('/Applications/REW.app'); 
    } else {
        console.warn("Automatic REW path detection on Linux is limited. Checking PATH only.");
         return 'roomeqwizard'; 
    }
    for (const p of commonPaths) {
        if (fs.existsSync(p)) {
             if (platform === 'darwin' && p.endsWith('.app')) return p;
             if (platform !== 'darwin' || p.includes('/Contents/MacOS/')) return p;
        }
    }
    if (platform !== 'win32' && platform !== 'darwin') return 'roomeqwizard';
    return null;
}

function launchRew(rewPath, memoryArg = "-Xmx4096m") { 
    return new Promise((resolve) => {
        const platform = os.platform();
        let cmd = '';
        let args = [];
        const apiArg = '-api';
        console.log(`Attempting to launch REW from: ${rewPath}`);
        if (platform === 'win32') {
            cmd = `"${rewPath}"`; 
            args = [memoryArg, apiArg];
        } else if (platform === 'darwin') {
             if (rewPath.endsWith('.app')) {
                cmd = 'open';
                args = [rewPath, '--args', memoryArg, apiArg];
             } else {
                 cmd = rewPath;
                 args = [memoryArg, apiArg];
             }
        } else {
            cmd = rewPath;
            args = [memoryArg, apiArg];
        }
        try {
            //console.log(`Executing: ${cmd} ${args.join(' ')}`);
            const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: true }); 
            child.on('error', (err) => {
                console.error(`Error launching REW: ${err.message}`);
                resolve(false);
            });
            child.unref();
            //console.log("REW launch command executed.");
            resolve(true); 

        } catch (err) {
             console.error(`Exception trying to launch REW: ${err.message}`);
            resolve(false);
        }
    });
}

function checkRewApi2(port = 4735, timeout = 1500) {
    return new Promise((resolve) => {
        console.log(`Checking for REW API on localhost:${port}...`);
        const socket = new net.Socket();
        let connected = false;
        const timer = setTimeout(() => {
            console.log(`API check timed out after ${timeout}ms.`);
            socket.destroy();
            resolve(false); 
        }, timeout);
        socket.on('connect', () => {
            connected = true;
            console.log("API connection successful (port is open).");
            socket.end(); 
            clearTimeout(timer);
            resolve(true);
        });
        socket.on('error', (err) => {
            clearTimeout(timer);
            if (err.code === 'ECONNREFUSED') {
             //console.log("API connection refused (port open but not accepting?).");
             resolve(false); 
            } else {
                 console.warn(`API connection error: ${err.message} (Code: ${err.code})`);
                 resolve(false); 
            }
        });
        socket.connect(port, 'localhost');
    });
}

function checkRewApi(port = 4735, timeout = 2000) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'localhost',
            port: port,
            path: '/version',
            method: 'GET',
            timeout: timeout,
        };

        //console.log(`Checking REW API status at http://localhost:${port}/version ...`);

        const req = http.request(options, (res) => {
            let responseBody = '';
            res.setEncoding('utf8');

            res.on('data', (chunk) => {
                responseBody += chunk; // Collect body just in case we need it for debug
            });

            res.on('end', () => {
                if (res.statusCode === 200) {
                    //console.log(`REW is open and its API server is running`);
                    resolve(true); // Success!
                } else {
                    console.warn(`REW responded with unexpected status: ${res.statusCode}`);
                    resolve(false); // API is there but not giving the expected OK for /version
                }
            });
        });

        // Handle errors during the request (e.g., connection refused, timeout)
        req.on('error', (err) => {
            // ECONNREFUSED means nothing is listening on that port
            if (err.code === 'ECONNREFUSED') {
                 console.log(`REW API connection refused on port ${port}. (Not running or blocked?)`);
            } else {
                console.warn(`REW API check error: ${err.message} (Code: ${err.code})`);
            }
            resolve(false); // Any error means API is not ready
        });

        // Handle explicit timeout event
        req.on('timeout', () => {
            console.warn(`REW API check timed out after ${timeout}ms.`);
            req.destroy(); // Clean up the request socket
            resolve(false);
        });

        // Send the request
        req.end();
    });
}


async function ensureRewReady() {
    console.log("\n--- Checking REW Status ---");
    const platform = os.platform();
    const procName = platform === 'win32' ? 'roomeqwizard.exe' : (platform === 'darwin' ? 'REW' : 'roomeqwizard'); 
    let isRunning = await isProcessRunning(procName);
    //console.log(`Is REW process (${procName}) running? ${isRunning}`);
    if (isRunning) {
        const isApiListening = await checkRewApi(rewApiPort);
        if (isApiListening) {
            console.log("REW is open and API server seems running. Good to go!");
            return true;
        } else {
            //console.log("REW is running, but API port check failed.");
             const { proceedAnyway } = await inquirer.prompt([{
                 type: 'confirm',
                 name: 'proceedAnyway',
                 message: `REW seems to be running, but the API on port ${rewApiPort} isn't responding.\nThis might be okay if REW is using a different port or starting up.\nDo you want to continue and open A1 Evo anyway?`,
                 default: true
             }]);
             return proceedAnyway;
        }
    }
    console.log("Room EQ Wizard is not running!");
    const rewPath = findRewPath();
    if (!rewPath) {
        console.error("Could not automatically find REW installation in common locations.");
        console.log(`Please start REW manually, ensuring the API server is enabled (usually via command line '-api' or a setting within REW).`);
         const { proceedManual } = await inquirer.prompt([{
             type: 'confirm',
             name: 'proceedManual',
             message: `Could not find REW. Please start it manually and start its API server.\nContinue to open A1 Evo once REW is ready?`,
             default: true
         }]);
        return proceedManual;
    }
    const memoryArg = "-Xmx4096m";
    const launchInitiated = await launchRew(rewPath, memoryArg);
    if (!launchInitiated) {
        console.error("Failed to execute REW launch command.");
         const { proceedError } = await inquirer.prompt([{
             type: 'confirm',
             name: 'proceedError',
             message: `Failed to start REW automatically. Please start it manually and start its API server.\nContinue to open A1 Evo once REW is ready?`,
             default: true
         }]);
        return proceedError;
    }
    const waitTime = 5000; 
    //console.log(`REW launch initiated. Waiting ${waitTime / 1000} seconds for API server to start...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));

    const isApiListeningAfterLaunch = await checkRewApi(rewApiPort);
    if (isApiListeningAfterLaunch) {
        console.log("REW launched and API server seems to be running. Proceeding...");
        return true;
    } else {
        console.error(`Launched REW, but API port ${rewApiPort} did not become active within ${waitTime / 1000} seconds.`);
        console.log("Ensure REW's API server is enabled");
         const { proceedFail } = await inquirer.prompt([{
             type: 'confirm',
             name: 'proceedFail',
             message: `Started REW, but couldn't confirm API status on port ${rewApiPort}.\nContinue to open A1 Evo anyway?`,
             default: true
         }]);
        return proceedFail;
    }
}

initializeApp();

process.on('SIGINT', () => {
    console.log("\nShutting down...");
    if (mainServer) {
        mainServer.close(() => {
            //console.log("Server closed.");
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
});
