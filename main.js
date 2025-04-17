
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
const HTML_FILEPATH = path.join(APP_BASE_PATH, HTML_FILENAME);

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

function formatDataForFrontend(details) {
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

async function runFullDiscoveryAndSave(interactive = false) {
    console.log('\nStarting AVR discovery...');
    const discovery = new UPNPDiscovery(CONFIG.timeouts.discovery);
    let devices = [];
    try {
        devices = await discovery.discover();
        console.log(`Discovery finished. Found ${devices.length} potential UPnP devices.`);
    } catch (error) {
        console.error('Discovery process failed:', error);
        console.log("Please check network connection and firewall settings.");
        return false; 
    }
    const potentialAvrs = devices.filter(dev =>
         dev.modelName && dev.modelName !== 'Unknown Model' && 
         (/Denon|Marantz/i.test(dev.manufacturer || '') ||
         /AVR|Receiver|SR|NR|AV|Cinema/i.test(dev.friendlyName || '') ||
         /AVR|SR|NR|AV|Cinema/i.test(dev.modelName || ''))
    );
    console.log(`Found ${potentialAvrs.length} potential Denon/Marantz AVRs.`);
    let selectedAvr = null;
    if (potentialAvrs.length === 0) {
        console.log('No suitable Denon/Marantz AVR found on the network.');
        return false;
    } else if (potentialAvrs.length === 1) {
        selectedAvr = potentialAvrs[0];
        console.log(`Automatically selected AVR: ${selectedAvr.friendlyName} (${selectedAvr.manufacturer} ${selectedAvr.modelName}) at ${selectedAvr.address}`);
    } else {
        if (interactive) {
            selectedAvr = await UPNPDiscovery.interactiveDeviceSelection(potentialAvrs);
            if (!selectedAvr) {
                console.log("No device selected.");
                return false;
            }
            console.log(`Selected AVR: ${selectedAvr.friendlyName} at ${selectedAvr.address}`);
        } else {
            console.log('Multiple AVRs found. Run Option 1 to select interactively.');
            return false; 
        }
    }
    let socket;
    try {
        socket = await connectToAVR(selectedAvr.address, AVR_CONTROL_PORT, CONFIG.timeouts.connection);
        console.log("Connected. Fetching detailed configuration...");
        const avrInfo = await getAvrInfoAndStatus(socket, CONFIG.timeouts.command);
        const fullDetails = {
             ...selectedAvr, 
             ...avrInfo     
         };
        if (!fullDetails.ip || !fullDetails.modelName || fullDetails.modelName === '*Unknown') {
             throw new Error("Failed to retrieve essential details (IP, Model Name) from the AVR.");
        }
        //console.log("Formatting data for configuration file...");
        const frontendData = formatDataForFrontend(fullDetails);
        console.log(`Saving configuration to ${CONFIG_FILENAME}...`);
        fs.writeFileSync(CONFIG_FILEPATH, JSON.stringify(frontendData, null, 2));
        console.log('Configuration saved successfully.');
        cachedAvrConfig = frontendData; 
        return true; 
    } catch (err) {
        console.error(`Error connecting to or getting config from ${selectedAvr.address}: ${err.message}`);
        return false; 
    } finally {
        if (socket) {
            socket.end();
            console.log(`Connection to ${selectedAvr.address} closed.`);
        }
    }
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
        ? "1. Replace AVR Configuration File"
        : "1. Create AVR Configuration File";
    const choices = [
        { name: configOptionName, value: 'config' },
        { name: '2. Run Optimization (Opens A1Evo in browser)', value: 'optimize' },
        { name: '3. Transfer Calibration', value: 'transfer' },
        new inquirer.Separator(),
        { name: 'Exit', value: 'exit' },
    ];
    if (!configExists) { 
         choices[1].name += ' (Requires Config File)'; 
         choices[1].disabled = true;
         choices[2].name += ' (Requires Config File)'; 
         choices[2].disabled = true;
    }
    choices[2].name += ' (Requires Optimization Result File)';
    
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
            //console.log(`Opening ${optimizationUrl} in your browser...`);
            //console.log(`A1Evo will automatically load '${CONFIG_FILENAME}' from the server.`);
            //console.log(`>>> NOTE: A1Evo.html will likely save its output calibration file`);
            //console.log(`>>> (e.g., *.oca) to your browser's default Downloads folder.`);
            //console.log(`>>> You will need this file for Option 3.`);
            try {
                await open(optimizationUrl, {wait: false});
                console.log("Browser opened. Please complete the optimization process in A1Evo.");
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
            console.log(`Executing: ${cmd} ${args.join(' ')}`);
            const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: true }); 
            child.on('error', (err) => {
                console.error(`Error launching REW: ${err.message}`);
                resolve(false);
            });
            child.unref();
            console.log("REW launch command executed.");
            resolve(true); 

        } catch (err) {
             console.error(`Exception trying to launch REW: ${err.message}`);
            resolve(false);
        }
    });
}

function checkRewApi(port = 4735, timeout = 1500) {
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

async function ensureRewReady() {
    console.log("\n--- Checking REW Status ---");
    const platform = os.platform();
    const procName = platform === 'win32' ? 'roomeqwizard.exe' : (platform === 'darwin' ? 'REW' : 'roomeqwizard'); 
    const rewApiPort = 4735; 
    let isRunning = await isProcessRunning(procName);
    //console.log(`Is REW process (${procName}) running? ${isRunning}`);
    if (isRunning) {
        const isApiListening = await checkRewApi(rewApiPort);
        if (isApiListening) {
            console.log("REW is running and API port seems active. Good to go!");
            return true;
        } else {
            //console.log("REW is running, but API port check failed.");
             const { proceedAnyway } = await inquirer.prompt([{
                 type: 'confirm',
                 name: 'proceedAnyway',
                 message: `REW seems to be running, but the API on port ${rewApiPort} isn't responding.\nThis might be okay if REW is using a different port or starting up.\nDo you want to continue and open A1Evo anyway?`,
                 default: true
             }]);
             return proceedAnyway;
        }
    }
    console.log("REW process not detected. Attempting to find and launch...");
    const rewPath = findRewPath();
    if (!rewPath) {
        console.error("Could not automatically find REW installation in common locations.");
        console.log(`Please start REW manually, ensuring the API server is enabled (usually via command line '-api' or a setting within REW).`);
         const { proceedManual } = await inquirer.prompt([{
             type: 'confirm',
             name: 'proceedManual',
             message: `Could not find REW. Please start it manually with the API enabled.\nContinue to open A1Evo once REW is ready?`,
             default: true
         }]);
        return proceedManual;
    }
    const memoryArg = "-Xmx8192m";
    const launchInitiated = await launchRew(rewPath, memoryArg);
    if (!launchInitiated) {
        console.error("Failed to execute REW launch command.");
         const { proceedError } = await inquirer.prompt([{
             type: 'confirm',
             name: 'proceedError',
             message: `Failed to start REW automatically. Please start it manually with the API enabled.\nContinue to open A1Evo once REW is ready?`,
             default: true
         }]);
        return proceedError;
    }
    const waitTime = 8000; 
    console.log(`REW launch initiated. Waiting ${waitTime / 1000} seconds for API server to start...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));

    const isApiListeningAfterLaunch = await checkRewApi(rewApiPort);
    if (isApiListeningAfterLaunch) {
        console.log("REW launched and API port seems active. Proceeding.");
        return true;
    } else {
        console.error(`Launched REW, but API port ${rewApiPort} did not become active within ${waitTime / 1000} seconds.`);
        console.log("Ensure REW's API server is enabled");
         const { proceedFail } = await inquirer.prompt([{
             type: 'confirm',
             name: 'proceedFail',
             message: `Started REW, but couldn't confirm API status on port ${rewApiPort}.\nContinue to open A1Evo anyway?`,
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
