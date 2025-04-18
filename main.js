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
// --- MODIFICATION START: Increased command timeout ---
// Original: const CONFIG = {timeouts: {discovery: 5000, connection: 3000, command: 5000}};
const CONFIG = {timeouts: {discovery: 5000, connection: 3000, command: 10000}}; // Increased command timeout to 10 seconds
// --- MODIFICATION END ---
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
                            // console.log('Discovery socket closed.'); // Less verbose
                            resolve(Array.from(devices.values()));
                         });
                    } else {
                         // console.log('Discovery socket already closed or not bound.'); // Less verbose
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
                                // Check if already added by URL, prevent duplicates if multiple STs match
                                if (!devices.has(deviceInfo.descriptionUrl) && deviceInfo.modelName && deviceInfo.modelName !== 'Unknown Model') {
                                     // Only log if it looks like a valid device to reduce noise
                                     console.log(`Found potential device via UPnP: ${deviceInfo.manufacturer} ${deviceInfo.modelName} at ${rinfo.address}`);
                                    devices.set(deviceInfo.descriptionUrl, {
                                        address: rinfo.address,
                                        port: rinfo.port, // Usually SSDP port (1900), not control port
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
                    // Some systems might require adding membership *after* bind
                    this.socket.addMembership(this.SSDP_MULTICAST_ADDR);
                    console.log(`Searching for AVRs via UPnP (Timeout: ${this.timeout / 1000}s)...`);
                    this.SEARCH_TARGETS.forEach(target => {
                        const searchRequest = Buffer.from(
                            'M-SEARCH * HTTP/1.1\r\n' +
                            `HOST: ${this.SSDP_MULTICAST_ADDR}:${this.SSDP_PORT}\r\n` +
                            'MAN: "ssdp:discover"\r\n' +
                            'MX: 2\r\n' + // Max wait time for response (in seconds)
                            `ST: ${target}\r\n\r\n`
                        );
                        // Send to multicast address
                        this.socket.send(searchRequest, 0, searchRequest.length, this.SSDP_PORT, this.SSDP_MULTICAST_ADDR, (err) => {
                            if (err) {
                                console.error(`Error sending M-SEARCH for target ${target}: ${err}`);
                                // Don't reject immediately, allow other sends/discovery to continue
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
                port: parsedUrl.port || 80, // Default HTTP port if not specified
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'GET',
                timeout: CONFIG.timeouts.command // Reuse command timeout for fetching description
            };
            // console.log(`Fetching description: ${locationUrl}`); // Debug log
            const req = http.request(options, (res) => {
                let data = '';
                if (res.statusCode !== 200) {
                     // Don't warn for redirects, follow them if needed (though unlikely for device XML)
                     if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                          console.log(`Following redirect from ${locationUrl} to ${res.headers.location}`);
                          res.resume(); // Consume data to free resources
                          this.fetchDeviceDescription(res.headers.location).then(resolve).catch(reject); // Recursive call
                          return;
                     }
                     console.warn(`Failed to get description ${locationUrl}. Status: ${res.statusCode}`);
                     res.resume(); // Consume data from aborted request
                     // Resolve with unknowns but keep URL
                     resolve({ modelName: 'Unknown Model', manufacturer: 'Unknown Manufacturer', friendlyName: 'Unknown Device', descriptionUrl: locationUrl });
                     return;
                }
                res.setEncoding('utf8');
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        // Make matching less strict (case-insensitive, optional whitespace)
                        const modelNameMatch = data.match(/<modelName>(.*?)<\/modelName>/i);
                        const manufacturerMatch = data.match(/<manufacturer>(.*?)<\/manufacturer>/i);
                        const friendlyNameMatch = data.match(/<friendlyName>(.*?)<\/friendlyName>/i);

                        // Basic cleanup: remove potential XML CDATA wrappers if present
                        const clean = (str) => str ? str.replace(/<!\[CDATA\[(.*?)\]\]>/, '$1').trim() : 'Unknown';

                        const modelName = modelNameMatch ? clean(modelNameMatch[1]) : 'Unknown Model';
                        const manufacturer = manufacturerMatch ? clean(manufacturerMatch[1]) : 'Unknown Manufacturer';
                        const friendlyName = friendlyNameMatch ? clean(friendlyNameMatch[1]) : 'Unknown Device';

                        // console.log(`Parsed from ${locationUrl}: M='${manufacturer}', MN='${modelName}', FN='${friendlyName}'`); // Debug log

                        resolve({
                            modelName: modelName,
                            manufacturer: manufacturer,
                            friendlyName: friendlyName,
                            descriptionUrl: locationUrl // Always return the URL we successfully fetched
                        });
                    } catch (error) {
                        console.error("Error parsing device description XML:", error, "\nXML Data (first 500 chars):", data.substring(0, 500));
                        // Resolve with unknowns but keep URL
                        resolve({ modelName: 'Unknown Model', manufacturer: 'Unknown Manufacturer', friendlyName: 'Unknown Device', descriptionUrl: locationUrl });
                    }
                });
            });
            req.on('error', (e) => {
                 // Log specific error codes if helpful
                 console.error(`Error requesting description ${locationUrl}: ${e.message} (Code: ${e.code})`);
                 // Resolve with unknowns but keep URL
                 resolve({ modelName: 'Unknown Model', manufacturer: 'Unknown Manufacturer', friendlyName: 'Unknown Device', descriptionUrl: locationUrl });
            });
             req.on('timeout', () => {
                 req.destroy(); // Explicitly destroy the socket on timeout
                 console.warn(`Timeout requesting description ${locationUrl}`);
                  // Resolve with unknowns but keep URL
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
            // Use a consistent display format
            name: `[${index + 1}] ${device.friendlyName || 'Unknown Name'} (${device.manufacturer || 'Unknown Manuf.'} ${device.modelName || 'Unknown Model'}) - ${device.address}`,
            value: index
        }));
        choices.push(new inquirer.Separator());
        choices.push({ name: 'Cancel / Enter IP Manually', value: -1 }); // Clarify cancel option
        const answers = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedDeviceIndex',
                message: 'Multiple potential AVRs found via UPnP. Select the target device:',
                choices: choices,
                pageSize: Math.min(15, choices.length + 1) // Adjust page size dynamically
            }
        ]);
        if (answers.selectedDeviceIndex === -1) {
            console.log("Device selection cancelled or user chose manual entry.");
            return null;
        }
        return devices[answers.selectedDeviceIndex];
    }
}
async function connectToAVR(ip, port = AVR_CONTROL_PORT, timeout = CONFIG.timeouts.connection) { // Default port and timeout
  return new Promise((resolve, reject) => {
    console.log(`Attempting to connect to ${ip}:${port} (Timeout: ${timeout / 1000}s)...`);
    const client = net.createConnection({ port, host: ip, timeout });
    let connectionTimeoutTimer; // Use a separate variable for clarity

    // Function to clean up listeners
    const cleanup = () => {
        clearTimeout(connectionTimeoutTimer);
        client.removeAllListeners('connect');
        client.removeAllListeners('error');
        client.removeAllListeners('timeout'); // Also remove net timeout listener
    };

    connectionTimeoutTimer = setTimeout(() => {
         console.error(`Connection to ${ip}:${port} timed out after ${timeout}ms.`);
         client.destroy(); // Ensure socket is destroyed
         reject(new Error(`Connection timed out after ${timeout}ms.`));
     }, timeout);

    client.once('connect', () => {
      cleanup(); // Remove timeout timer and error listeners
      console.log(`Successfully connected to ${ip}:${port}.`);
      resolve(client); // Resolve with the connected client socket
    });

    client.once('error', err => {
      cleanup(); // Remove timer and other listeners
      console.error(`Connection error to ${ip}:${port}: ${err.message}`);
      // Don't destroy here, createConnection likely handles it or it's already closed
      reject(new Error(`Connection error: ${err.message}`));
    });

    // Handle the 'timeout' event from net.createConnection as well
    client.once('timeout', () => {
        // This event fires if the net timeout option is hit, redundant with our timer but good practice
        cleanup();
        console.error(`Connection to ${ip}:${port} timed out (net.createConnection event).`);
        client.destroy();
        reject(new Error(`Connection timed out (net.createConnection event) after ${timeout}ms.`));
    });
  });
}

async function getAvrInfoAndStatus(socket, commandTimeout = CONFIG.timeouts.command) { // Use CONFIG timeout
  const sendRawAndParseJson = (hexWithChecksum, label) =>
    new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const packet = Buffer.from(hexWithChecksum, 'hex');
      let commandTimer; // Timer specific to this command
      let isActive = true; // Flag to prevent multiple resolves/rejects

      const cleanup = (error = null) => {
        if (!isActive) return; // Prevent double cleanup
        isActive = false;
        // console.log(`[${label}] Cleaning up listeners.`); // Debug log
        socket.removeListener('data', onData);
        socket.removeListener('error', onError); // Remove specific error handler
        clearTimeout(commandTimer);
        if (error) {
             // console.error(`[${label}] Rejecting with error: ${error.message}`); // Debug log
             reject(error);
        }
        // else: resolve() was called before cleanup
      };

      const onData = (data) => {
        if (!isActive) return; // Ignore data if already resolved/rejected/timed out
        // console.log(`[${label}] Raw data received (length ${data.length}): ${data.toString('utf8').substring(0,100)}...`); // DEBUG: Log received data
        buffer = Buffer.concat([buffer, data]);
        const utf8 = buffer.toString('utf8');
        const jsonStart = utf8.indexOf('{');
        const jsonEnd = utf8.lastIndexOf('}');

        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
          const potentialJson = utf8.slice(jsonStart, jsonEnd + 1);
          try {
            const parsed = JSON.parse(potentialJson);
            console.log(`[${label}] Successfully parsed JSON response.`);
            cleanup(); // Clean up before resolving
            resolve(parsed);
          } catch (err) {
             // JSON parse error - maybe incomplete? Keep waiting for more data unless timeout hits.
             // console.warn(`[${label}] Found potential JSON but failed to parse: ${err.message}. Buffer size: ${buffer.length}`); // Debug log
             // Optional: If buffer gets huge without valid JSON, reject earlier?
             if (buffer.length > 1 * 1024 * 1024) { // 1MB limit
                cleanup(new Error(`[${label}] Response buffer exceeded 1MB without valid JSON.`));
             }
          }
        } else {
            // No complete JSON structure found yet, wait for more data or timeout
            // console.log(`[${label}] No complete JSON object found yet in buffer (size: ${buffer.length})`); // Debug log
        }
      };

      const onError = (err) => {
        // This handles general socket errors during the command execution
        console.error(`[${label}] Socket error during command: ${err.message}`);
        cleanup(new Error(`Socket error during ${label}: ${err.message}`));
      };

      // Set the command timeout
      commandTimer = setTimeout(() => {
        console.error(`[${label}] Command timed out after ${commandTimeout}ms waiting for JSON response.`);
        // Optional: Log buffer content on timeout for debugging
        // console.error(`[${label}] Buffer content on timeout: ${buffer.toString('utf8')}`);
        cleanup(new Error(`[${label}] Timed out waiting for JSON response.`));
      }, commandTimeout);

      // Add listeners specific to this command execution
      socket.on('data', onData);
      socket.on('error', onError); // Add listener for socket errors

      console.log(`Sending command [${label}]...`);
      socket.write(packet, (err) => {
        if (err) {
          console.error(`[${label}] Socket write error: ${err.message}`);
          cleanup(new Error(`Write error during ${label}: ${err.message}`));
        } else {
           // console.log(`[${label}] Command sent successfully.`); // Debug log
        }
      });
    });

  try {
      // --- MODIFICATION START: Sequential execution ---
      // Original: const [infoJson, statusJson] = await Promise.all([infoJsonPromise, statusJsonPromise]);
      console.log("Fetching AVR Information (GET_AVRINF)...");
      const infoJson = await sendRawAndParseJson('54001300004745545f415652494e460000006c', 'GET_AVRINF');
      console.log("AVR Information received.");

      // Add a small delay - sometimes helps if the AVR needs a moment between commands
      await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay

      console.log("Fetching AVR Status (GET_AVRSTS)...");
      const statusJson = await sendRawAndParseJson('54001300004745545f41565253545300000089', 'GET_AVRSTS');
      console.log("AVR Status received.");
      // --- MODIFICATION END ---

      // --- Parsing Logic (Keep as is, looks okay) ---
      let activeChannels = [];
      let rawChSetup = [];
      let ampAssignString = null;
      let assignBin = null;
      // Determine EQ Type robustly
      let eqTypeString = "";
      if (infoJson?.EQType) eqTypeString = infoJson.EQType;
      else if (infoJson?.Audyssey?.Version) eqTypeString = infoJson.Audyssey.Version; // Fallback for older/different structures

      if (statusJson?.ChSetup && Array.isArray(statusJson.ChSetup)) {
          rawChSetup = statusJson.ChSetup;
          activeChannels = statusJson.ChSetup
              .filter(entry => entry && typeof entry === 'object' && Object.values(entry)[0] !== 'N') // Filter non-active speakers marked 'N'
              .map(entry => Object.keys(entry)[0]); // Get the channel command ID (e.g., 'FL', 'SW1')
           console.log(`Detected Active Channels: ${activeChannels.join(', ') || 'None'}`);
      } else {
          // Don't throw error, maybe log warning, allows proceeding if other data is present
          console.warn("Channel Setup data (ChSetup) missing or invalid in AVR status response.");
          // throw new Error("Channel Setup data (ChSetup) missing or invalid.");
      }

      // Amp Assign logic
      ampAssignString = statusJson?.AmpAssign;
      assignBin = statusJson?.AssignBin; // This is often called 'ampAssignInfo' in Denon docs/other tools
      if (!ampAssignString) console.warn("AmpAssign string missing from AVR status.");
      if (!assignBin) console.warn("AssignBin string (ampAssignInfo) missing from AVR status.");

      // Return all gathered data
      return {
          ip: socket.remoteAddress, // Get IP from the socket
          rawChSetup,
          ampAssignString,
          assignBin, // Keep original name from response
          eqTypeString,
          // Include raw responses if needed for debugging frontend?
          // rawInfoResponse: infoJson,
          // rawStatusResponse: statusJson
      };
  } catch (error) {
      console.error(`Failed to get necessary AVR status/info: ${error.message}`);
      // Don't just re-throw, maybe add more context
      throw new Error(`Failed during AVR status/info retrieval: ${error.message}`);
  }
}

function formatDataForFrontend(details) {
     // Ensure details object exists
     if (!details) {
          throw new Error("Cannot format data: Input details object is missing.");
     }

     const targetModelName = details.modelName || 'Unknown Model'; // Use provided model name
     const ipAddress = details.ip || null; // Use IP from details
     const eqTypeString = details.eqTypeString || ""; // Use EQ type from details
     const ampAssignString = details.ampAssignString; // Use AmpAssign from details
     const assignBin = details.assignBin; // Use AssignBin from details
     const rawChSetup = details.rawChSetup || []; // Use rawChSetup, default to empty array

     let enMultEQType = null; // 0: MultEQ, 1: XT, 2: XT32
     if (typeof eqTypeString === 'string' && eqTypeString) {
         if (eqTypeString.includes('XT32')) enMultEQType = 2;
         else if (eqTypeString.includes('XT')) enMultEQType = 1; // Check for XT *after* XT32
         else if (eqTypeString.includes('MultEQ')) enMultEQType = 0; // Check for base MultEQ last
         // Add more checks if other EQ types exist (e.g., Dirac?)
     }

     // Handle case where EQ type couldn't be determined
     if (enMultEQType === null) {
         console.warn(`Could not determine MultEQ Type from EQ string: "${eqTypeString}". Defaulting may be needed or configuration might fail.`);
         // Depending on requirements, either throw error or allow proceeding with a default/null value
         // throw new Error("Could not determine MultEQ Type from provided string.");
     }

     // Validate required fields needed by frontend
     if (!ampAssignString) console.warn("Amp Assign string missing. Frontend functionality might be limited.");
     // AmpAssignInfo (AssignBin) is important for detailed amp config interpretation
     if (!assignBin) console.warn("Amp Assign Info (AssignBin) missing. Frontend functionality might be limited.");

     // Process channel setup
     let detectedChannels = [];
     let subCount = 0;
     if (Array.isArray(rawChSetup)) {
          rawChSetup.forEach(entry => {
              if (!entry || typeof entry !== 'object') return; // Skip invalid entries
              const commandId = Object.keys(entry)[0]; // e.g., 'FL', 'SW1', 'TML'
              const speakerType = entry[commandId]; // e.g., 'L', 'N', 'SUB'

              // Only add channels that are not explicitly set to 'None' ('N')
              if (speakerType !== 'N') {
                  // Standardize SW command IDs if needed (e.g., SWMIX1 -> SW1)
                  let standardizedId = commandId;
                  if (commandId.startsWith('SWMIX')) {
                       standardizedId = commandId.replace('MIX', ''); // SWMIX1 -> SW1
                  }
                  detectedChannels.push({ commandId: standardizedId });

                  // Count subwoofers based on standardized ID
                  if (standardizedId.startsWith('SW') || standardizedId === 'LFE') { // Consider LFE too? Usually SWx is used.
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

     // Construct the object for the frontend
     const simplifiedConfig = {
         targetModelName: targetModelName,
         ipAddress: ipAddress,
         enMultEQType: enMultEQType, // Can be null if undetermined
         subwooferNum: subCount,
         ampAssign: ampAssignString || null, // Pass null if missing
         ampAssignInfo: assignBin || null, // Pass null if missing (frontend needs to handle null)
         detectedChannels: detectedChannels // Array of { commandId: string }
     };

     // Log the final structure being sent to frontend (optional debug)
     // console.log("Formatted data for frontend:", JSON.stringify(simplifiedConfig, null, 2));

     return simplifiedConfig;
}

async function fetchModelFromGoform(ipAddress) {
    return new Promise((resolve) => {
        // Use standard port 80 for HTTP unless specified otherwise
        const url = `http://${ipAddress}/goform/formMainZone_MainZoneXml.xml`;
        console.log(`Attempting to fetch model name from ${url} (Timeout: ${CONFIG.timeouts.command / 1000}s)...`);
        const options = {
            method: 'GET',
            timeout: CONFIG.timeouts.command // Reuse command timeout
        };

        const req = http.request(url, options, (res) => { // Pass URL directly to http.request
            let data = '';
            if (res.statusCode !== 200) {
                console.warn(`Failed to get ${url}. Status: ${res.statusCode} ${res.statusMessage}`);
                res.resume(); // Consume response data
                resolve(null); // Indicate failure
                return;
            }
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    // More robust regex: case-insensitive, handles whitespace around tags
                    const modelMatch = data.match(/<ModelName>\s*<value>(.*?)<\/value>\s*<\/ModelName>/i);
                    const friendlyMatch = data.match(/<FriendlyName>\s*<value>(.*?)<\/value>\s*<\/FriendlyName>/i);

                    let modelName = modelMatch ? modelMatch[1].trim() : null;
                    const friendlyName = friendlyMatch ? friendlyMatch[1].trim() : null;

                    // Refined logic: Prefer ModelName unless it's clearly generic or absent.
                    // If ModelName is bad, use FriendlyName only if it's reasonably specific.
                    let finalName = modelName;
                    let source = modelName ? "ModelName tag" : "None";

                    if (!modelName || /receiver|network (audio|av)|(av|media) (server|renderer|player)/i.test(modelName)) {
                       if (friendlyName && friendlyName.length > 3 && !/receiver|network (audio|av)|(av|media) (server|renderer|player)/i.test(friendlyName)) {
                           console.log(`Using FriendlyName ("${friendlyName}") as model, as ModelName ("${modelName}") was generic or missing.`);
                           finalName = friendlyName;
                           source = "FriendlyName tag";
                       } else {
                           console.log(`ModelName ("${modelName}") was generic/missing, and FriendlyName ("${friendlyName}") was also unusable or absent.`);
                           finalName = null; // Explicitly set to null if neither is good
                           source = "None Found";
                       }
                    }

                    if (finalName) {
                         console.log(`Model name identified as "${finalName}" via /goform/ (${source}).`);
                    } else {
                         console.log("Could not identify a specific model name via /goform/.");
                    }
                    resolve(finalName); // Return the determined name (could be null)

                } catch (parseError) {
                    console.error(`Error parsing XML from ${url}:`, parseError);
                    resolve(null); // Indicate failure on parse error
                }
            });
        });

        req.on('error', (e) => {
            // Log the specific error code if available
            console.error(`Error requesting ${url}: ${e.message} (Code: ${e.code})`);
            resolve(null); // Indicate failure on request error
        });

        req.on('timeout', () => {
            req.destroy(); // Clean up the request socket
            console.error(`Timeout requesting ${url} after ${CONFIG.timeouts.command}ms`);
            resolve(null); // Indicate failure on timeout
        });
        req.end(); // Send the request
    });
}

async function runFullDiscoveryAndSave(interactive = true) {
    console.log('\nStarting AVR discovery and configuration process...');
    let targetIp = null;
    let modelName = null;
    let manufacturer = null; // Store manufacturer if found
    let initialFriendlyName = null; // Store initial friendly name if found
    let modelSource = "None"; // Track where the model name came from
    let avrFoundViaDiscovery = false;
    let selectedInitialInfo = null; // Store the full device object from UPnP selection/auto-detection

    // --- Stage 1: Try UPnP Discovery ---
    try {
        const discovery = new UPNPDiscovery(CONFIG.timeouts.discovery);
        let devices = await discovery.discover();
        console.log(`UPnP Discovery finished. Found ${devices.length} distinct device description(s).`);

        // Filter more carefully for potential AVRs (look for Receiver in ST or model/friendly name)
        const potentialAvrs = devices.filter(dev =>
            (dev.usn && /Receiver/i.test(dev.usn)) || // Check USN for Receiver type
            /Denon|Marantz/i.test(dev.manufacturer || '') || // Check manufacturer
            (/AVR|Receiver|SR|NR|AV|Cinema/i.test(dev.modelName || '') && !/MediaRenderer|MediaServer/i.test(dev.modelName || '')) || // Check model name (avoid media renderers)
            (/AVR|Receiver|SR|NR|AV|Cinema/i.test(dev.friendlyName || '') && !/MediaRenderer|MediaServer/i.test(dev.friendlyName || '')) // Check friendly name
        );
        console.log(`Found ${potentialAvrs.length} potential AVR description(s) matching filters.`);

        // Group by IP address to handle multiple descriptions for the same device
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
            // Select the "best" description (most complete/likely)
            selectedInitialInfo = descriptionsForIp.find(d => d.modelName && !/Unknown|MediaRenderer|MediaServer/i.test(d.modelName)) ||
                                 descriptionsForIp.find(d => d.friendlyName && !/Unknown|MediaRenderer|MediaServer/i.test(d.friendlyName)) ||
                                 descriptionsForIp[0]; // Fallback to the first one
            avrFoundViaDiscovery = true;
            console.log(`Automatically selected single potential AVR at ${targetIp}`);
        } else if (uniqueIPs.length > 1 && interactive) {
            console.warn(`Multiple potential AVR IPs found via UPnP.`);
            // Prepare choices using the best description available for each IP
            const choicesForPrompt = uniqueIPs.map(ip => {
                 const descriptions = groupedByIp[ip];
                 return descriptions.find(d => d.modelName && !/Unknown|MediaRenderer|MediaServer/i.test(d.modelName)) ||
                        descriptions.find(d => d.friendlyName && !/Unknown|MediaRenderer|MediaServer/i.test(d.friendlyName)) ||
                        descriptions[0]; // Fallback
            }).filter(Boolean); // Ensure no undefined entries if grouping failed

            selectedInitialInfo = await UPNPDiscovery.interactiveDeviceSelection(choicesForPrompt);
            if (selectedInitialInfo) {
                 avrFoundViaDiscovery = true;
                 targetIp = selectedInitialInfo.address;
                 console.log(`User selected AVR at ${targetIp}`);
            } else {
                 console.log("No device selected by user from UPnP list.");
                 // Allow falling through to manual IP entry
            }
        } else if (uniqueIPs.length > 1 && !interactive) {
            console.error("Automatic check failed: Multiple potential AVR IPs found via UPnP. Cannot auto-select.");
            return false; // Cannot proceed non-interactively
        }
        // If uniqueIPs.length is 0, UPnP didn't find a suitable AVR

        // Extract initial info if a device was selected/found via UPnP
        if (selectedInitialInfo) {
             modelName = selectedInitialInfo.modelName;
             manufacturer = selectedInitialInfo.manufacturer;
             initialFriendlyName = selectedInitialInfo.friendlyName;
             // Validate the model name from UPnP
             if (modelName && !/Unknown Model|MediaRenderer|MediaServer/i.test(modelName)) {
                 modelSource = "UPnP Description XML";
             } else {
                 console.log(`UPnP provided model name "${modelName}" is unreliable or missing. Will try other methods.`);
                 modelName = null; // Reset if UPnP gave a bad name
             }
        }

    } catch (discoveryError) {
        console.error(`Error during UPnP discovery phase: ${discoveryError.message}`);
        // Continue to manual IP entry if interactive
    }

    // --- Stage 2: Manual IP Entry (If UPnP failed or was cancelled AND interactive) ---
    if (!targetIp && interactive) {
        console.log("\nUPnP discovery did not identify a target AVR IP, or selection was cancelled.");
        try {
            const ipAnswer = await inquirer.prompt([{
                type: 'input', name: 'manualIp', message: 'Please enter the AVR IP address manually (or leave blank to cancel):',
                validate: input => {
                     if (input === '') return true; // Allow blank to cancel
                     return (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input)) ? true : 'Please enter a valid IPv4 address or leave blank.';
                }
            }]);
            if (ipAnswer.manualIp) {
                targetIp = ipAnswer.manualIp;
                console.log(`Using manually entered IP: ${targetIp}`);
                modelName = null; // Reset model name, needs confirmation/lookup
                manufacturer = null; // Reset manufacturer
                initialFriendlyName = null; // Reset friendly name
                modelSource = "Manual IP (Model Unknown)";
                selectedInitialInfo = { address: targetIp }; // Create placeholder info for consistency
            } else {
                 console.log("Manual IP entry cancelled.");
                 // Fall through to the final IP check
            }
        } catch (promptError) {
            console.error("Error during manual IP prompt:", promptError);
            return false; // Abort on prompt error
        }
    }

    // If still no IP (e.g., non-interactive UPnP failure, or user cancelled manual prompt), abort.
    if (!targetIp) {
        console.error("Configuration aborted: No target IP address could be determined.");
        return false;
    }


    // --- Stage 3: Try /goform/ XML (If model still unknown OR user might want to verify) ---
    // Always try goform if the model wasn't sourced from there yet, as it's often more accurate than UPnP desc.
    if (modelSource !== "/goform/ XML") {
        console.log(`\nAttempting to verify/find model name via /goform/ endpoint on ${targetIp}...`);
        const goformModel = await fetchModelFromGoform(targetIp);
        if (goformModel) { // Check if we got a valid string back
            if (!modelName) { // If we didn't have a model name before
                modelName = goformModel;
                modelSource = "/goform/ XML";
                console.log(`Model name identified as "${modelName}" via /goform/.`);
            } else { // We have a modelName from UPnP, and goformModel is also valid
                const upnpLower = modelName.toLowerCase();
                const goformLower = goformModel.toLowerCase();

                if (upnpLower === goformLower) {
                    // Exact match (case-insensitive), confirmation is good.
                    console.log(`Model name "${modelName}" confirmed via /goform/.`);
                    modelSource = "/goform/ XML (Confirmed UPnP)";
                } else {
                    // Not an exact match, check the last 6 characters
                    const upnpLast6 = upnpLower.length >= 6 ? upnpLower.slice(-6) : null;
                    const goformLast6 = goformLower.length >= 6 ? goformLower.slice(-6) : null;

                    if (upnpLast6 && goformLast6 && upnpLast6 === goformLast6) {
                        // Last 6 characters match, likely the same model. Prefer the more complete /goform/ version.
                        console.log(`Partial model match: UPnP "${modelName}", /goform/ "${goformModel}". Using /goform/ version as base model matches.`);
                        modelName = goformModel; // Update to the potentially more complete name
                        modelSource = "/goform/ XML (Partial Match Accepted)";
                    } else {
                        // Last 6 characters also don't match OR one string is too short - genuine discrepancy.
                        console.warn(`Model name discrepancy: UPnP reported "${modelName}", /goform/ reports "${goformModel}".`);
                        if (interactive) {
                            const confirmGoform = await inquirer.prompt([{
                                type: 'confirm', name: 'useGoform',
                                message: `UPnP reported "${modelName}" but /goform/ reports "${goformModel}". These seem different. Use the /goform/ version ("${goformModel}")?`,
                                default: true // Still default to preferring goform if unsure
                            }]);
                            if (confirmGoform.useGoform) {
                                modelName = goformModel;
                                modelSource = "/goform/ XML (User Confirmed Discrepancy)";
                            } else {
                                // Keep the UPnP version if user rejects goform version
                                modelSource += " (User Rejected /goform/ Version)";
                            }
                        } else {
                            // Non-interactive, still prefer goform on discrepancy? Or maybe fail? Let's prefer goform for now.
                            console.log(`Non-interactive mode: Discrepancy detected. Preferring /goform/ version "${goformModel}".`);
                            modelName = goformModel;
                            modelSource = "/goform/ XML (Auto-selected on Discrepancy)";
                        }
                    }
                }
            }
        } else {
            console.log("Could not get a valid model name from /goform/ endpoint.");
            if (!modelName) modelSource = "None Found"; // Update source if goform failed and we had nothing before
        }
    }


    // --- Stage 4: Manual Model Name Confirmation/Entry (If interactive) ---
    let finalModelName = modelName; // Start with the best guess so far
    if (interactive) {
        let promptForModel = false;
        if (finalModelName && finalModelName !== 'Unknown Model') { // Check if we have a seemingly valid model name
            const confirm = await inquirer.prompt([{
                type: 'confirm', name: 'isCorrect',
                message: `Is "${finalModelName}" the correct model for the device at ${targetIp}? (Source: ${modelSource})`,
                default: true
            }]);
            if (!confirm.isCorrect) {
                 finalModelName = null; // Reset if user says it's wrong
                 promptForModel = true;
            }
        } else {
            // No valid model found automatically, or user rejected previous one
            console.log("\nCould not automatically determine or confirm the AVR model name.");
            promptForModel = true;
        }

        if (promptForModel) {
            const modelPrompt = await inquirer.prompt([{
                type: 'input', name: 'modelNameManual',
                message: 'Please enter the correct AVR Model Name (e.g., SR6011, X3800H):',
                validate: input => (input && input.trim().length > 1) ? true : 'Model name cannot be empty.' // Basic validation
            }]);
            finalModelName = modelPrompt.modelNameManual.trim();
            modelSource = "Manual Entry (User Provided)"; // Update source
        }
    } else { // Non-interactive: Must have found a valid model automatically
         if (!finalModelName || finalModelName === 'Unknown Model') {
             console.error(`Automatic check failed: Could not determine a valid AVR Model Name for ${targetIp}. (Last attempt source: ${modelSource})`);
             return false;
         }
         console.log(`Using automatically determined model name: "${finalModelName}" (Source: ${modelSource})`);
    }

    // Final check for a valid model name before proceeding
    if (!finalModelName) {
        console.error("Configuration aborted: Final Model Name could not be determined.");
        return false;
    }

    // --- Stage 5: Connect & Get Status ---
    let socket = null; // Initialize socket to null
    let avrOperationalData = null;
    try {
        socket = await connectToAVR(targetIp); // Uses defaults defined in function
        console.log(`Successfully connected to ${targetIp}:${AVR_CONTROL_PORT}. Fetching operational status...`);
        // Pass the connected socket and the configured command timeout
        avrOperationalData = await getAvrInfoAndStatus(socket, CONFIG.timeouts.command);
        console.log("Successfully retrieved operational status from AVR.");
    } catch (err) {
         // Error could be from connectToAVR or getAvrInfoAndStatus
         console.error(`Error during connection or status fetch for ${targetIp}: ${err.message}`);
         // Ensure socket is destroyed if it exists
         if (socket && !socket.destroyed) {
             socket.destroy();
             console.log(`Socket to ${targetIp} destroyed after error.`);
         }
         return false; // Indicate failure
    } finally {
         // Ensure the socket is closed cleanly if it's still open and no error occurred in the try block
         if (socket && !socket.destroyed) {
             socket.end(() => {
                 // console.log(`Connection to ${targetIp} closed gracefully after status fetch.`); // Less verbose
             });
         }
    }

    // --- Stage 6: Format and Save ---
    try {
       // Combine all gathered information
       const finalDetails = {
           // Data fetched directly from AVR:
           ip: avrOperationalData.ip, // Use IP confirmed from socket
           rawChSetup: avrOperationalData.rawChSetup,
           ampAssignString: avrOperationalData.ampAssignString,
           assignBin: avrOperationalData.assignBin,
           eqTypeString: avrOperationalData.eqTypeString,
           // Best available metadata:
           modelName: finalModelName, // The confirmed/entered model name
           manufacturer: manufacturer || '', // From UPnP if available
           friendlyName: initialFriendlyName || '', // From UPnP if available
       };

       // Format this combined data for the frontend/config file
       const frontendData = formatDataForFrontend(finalDetails);

       console.log(`\nSaving configuration to ${CONFIG_FILENAME} for model "${frontendData.targetModelName}" at ${frontendData.ipAddress}...`);
       fs.writeFileSync(CONFIG_FILEPATH, JSON.stringify(frontendData, null, 2));
       console.log('Configuration saved successfully.');
       cachedAvrConfig = frontendData; // Update runtime cache
       return true; // Indicate success
    } catch (formatSaveError) {
        console.error(`Error formatting or saving configuration: ${formatSaveError.message}`);
        // Log the details that caused the error if possible
        // console.error("Data causing formatting error:", finalDetails);
        return false; // Indicate failure
    }
}

// --- Load Config Function (Keep as is) ---
function loadConfigFromFile() {
    if (fs.existsSync(CONFIG_FILEPATH)) {
        try {
            console.log(`Loading configuration from ${CONFIG_FILENAME}...`);
            const fileContent = fs.readFileSync(CONFIG_FILEPATH, 'utf-8');
            cachedAvrConfig = JSON.parse(fileContent);
            // Check essential fields after loading
            if (!cachedAvrConfig.ipAddress || !cachedAvrConfig.targetModelName) {
                 console.warn(`Warning: Loaded config from ${CONFIG_FILENAME} seems incomplete (missing IP or Model Name). Consider re-running configuration.`);
            } else {
                console.log(`Configuration loaded for: ${cachedAvrConfig.targetModelName} at ${cachedAvrConfig.ipAddress}`);
            }
            return true;
        } catch (error) {
            console.error(`Error reading or parsing ${CONFIG_FILENAME}: ${error.message}`);
            cachedAvrConfig = null; // Clear cache on error
            // Optionally, offer to delete/backup the corrupt file?
            // fs.renameSync(CONFIG_FILEPATH, CONFIG_FILEPATH + '.corrupt-' + Date.now());
            return false;
        }
    } else {
        // console.log(`${CONFIG_FILENAME} not found.`); // Be less verbose if called at startup
        cachedAvrConfig = null;
        return false;
    }
}

// --- Main Menu (Adjustments for clarity and flow) ---
async function mainMenu() {
    const configExists = loadConfigFromFile(); // Load config and check existence simultaneously
    if (!configExists && !cachedAvrConfig) { // Check if load failed or file doesn't exist
        console.warn(`\nAVR Configuration (${CONFIG_FILENAME}) is missing or invalid.`);
    }

    const configOptionName = configExists
        ? "1. Re-create and save AVR configuration file"
        : "1. Discover AVR in the network and create and save configuration file";
    const optimizeDisabled = !configExists || !cachedAvrConfig?.ipAddress; // Disable if no config or IP
    const transferDisabled = optimizeDisabled; // Same condition for transfer

    const choices = [
        { name: configOptionName, value: 'config' },
        {
            name: `2. Start Optimization (opens A1 Evo in browser)${optimizeDisabled ? ' (Requires valid config)' : ''}`,
            value: 'optimize',
            disabled: optimizeDisabled
        },
        {
            name: `3. Transfer Calibration (requires .oca file)${transferDisabled ? ' (Requires valid config)' : ''}`,
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
            const success = await runFullDiscoveryAndSave(true); // Run interactively
            if (success) {
                 console.log("AVR configuration completed successfully.");
                 // No need to explicitly load again, runFullDiscoveryAndSave updates cache
            } else {
                 console.error("AVR configuration process failed or was cancelled.");
                 // Config might be missing or invalid, mainMenu will re-check on loop
            }
            await mainMenu(); // Loop back to main menu
            break;

        case 'optimize':
            // Double-check config just before starting
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

            // Check REW status *before* opening browser
            const rewReady = await ensureRewReady();
            if (!rewReady) {
                console.warn("\nREW check failed or user chose not to proceed. Aborting optimization.");
                await mainMenu(); // Return to menu if REW isn't ready/confirmed
                break;
            }

            // If REW check passed, proceed
            console.log('\n--- Starting Optimization ---');
            const optimizationUrl = `http://localhost:${SERVER_PORT}/`; // Use constant

            try {
                console.log(`Opening ${optimizationUrl} in your default web browser...`);
                await open(optimizationUrl, {wait: false}); // Don't wait for browser to close
                console.log("\nA1 Evo should now be open in your browser.");
                console.log("Complete the optimization steps there.");
                console.log("You can return here to transfer calibration or exit when finished.");
            } catch (error) {
                console.error(`\nError opening browser: ${error.message}`);
                console.error("Please manually open your browser to:", optimizationUrl);
            } finally {
                // Keep the server running, loop back to menu
                await mainMenu();
            }
            break;

        case 'transfer':
             // Double-check config just before starting
             if (!cachedAvrConfig || !cachedAvrConfig.ipAddress) {
                 console.error(`\nError: Cannot transfer calibration. Configuration (${CONFIG_FILENAME}) is missing or invalid.`);
                 console.warn("Please run Option 1 first.");
                 await mainMenu();
                 break;
             }
             console.log("\n--- Transfer Calibration ---");
             try {
                 const targetIp = cachedAvrConfig.ipAddress;
                 const scriptPath = path.join(__dirname, 'sendFilters.js'); // Assuming sendFilters.js is in the same directory
                 const nodePath = process.execPath; // Path to the current Node executable

                 if (!fs.existsSync(scriptPath)) {
                     throw new Error(`Required script 'sendFilters.js' not found at ${scriptPath}`);
                 }

                 console.log(`Executing filter transfer script for target IP: ${targetIp}`);
                 console.log("The script will prompt you to select the .oca file.");
                 console.log("-------------------------------------------------------------");

                 // Spawn the child process, inheriting stdio for interactive prompts
                 const child = spawn(nodePath, [scriptPath, targetIp], { stdio: 'inherit' });

                 // Wait for the child process to complete
                 await new Promise((resolve, reject) => {
                     child.on('error', (spawnError) => {
                         console.error(`\n[main.js] Failed to start sendFilters.js: ${spawnError.message}`);
                         reject(spawnError); // Reject the promise on spawn error
                     });
                     child.on('close', (code) => {
                         console.log("-------------------------------------------------------------");
                         //console.log(`\n[main.js] sendFilters.js process finished with exit code ${code}.`);
                         if (code === 0) {
                             console.log("Calibration transfer completed successfully!");
                             console.log("-------------------------------------------------------------");
                             resolve(); // Resolve the promise on success
                         } else {
                             // Don't log redundant error message here if stdio is inherited
                             reject(new Error(`Filter transfer failed with exit code ${code}.`));
                         }
                     });
                 });

             } catch (error) {
                 // Catch errors from file checks, spawning, or the promise rejection
                 console.error(`\n[main.js] Error during calibration transfer step: ${error.message}`);
                 // No need to print stack trace usually, error message is often enough
             } finally {
                await mainMenu(); // Always return to menu
             }
            break;

        case 'exit':
            console.log('\nExiting application...');
            if (mainServer) {
                mainServer.close(() => {
                    console.log("Server stopped.");
                    process.exit(0);
                });
                // Force exit after a short delay if server close hangs
                setTimeout(() => {
                     console.log("Forcing exit...");
                     process.exit(1);
                }, 2000);
            } else {
                process.exit(0);
            }
            break; // Technically unreachable after process.exit

        default:
            console.log('Invalid choice. Please try again.');
            await mainMenu();
            break;
    }
}

// --- Initialize App (Simplified Logging) ---
async function initializeApp() {
    console.log('-----------------------------');
    console.log('  A1 Evo Acoustica v1.0 App  ');
    console.log('-----------------------------');
    // loadConfigFromFile(); // Load attempt happens inside mainMenu now

    mainServer = http.createServer((req, res) => {
        const url = req.url;
        const method = req.method;
        // console.log(`[Server] Request: ${method} ${url}`); // Debug log

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
             // Serve the *cached* config if available, otherwise try reading file
             if (cachedAvrConfig) {
                 // console.log(`[Server] Serving cached ${CONFIG_FILENAME}`); // Debug
                 res.writeHead(200, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify(cachedAvrConfig));
             } else {
                 fs.readFile(CONFIG_FILEPATH, (err, data) => {
                    if (err) {
                        console.warn(`[Server] ${CONFIG_FILENAME} requested but not found or not cached.`);
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `${CONFIG_FILENAME} not found. Run configuration first.` }));
                    } else {
                         // console.log(`[Server] Serving ${CONFIG_FILENAME} from disk`); // Debug
                         try {
                            // Quick validation before sending
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
            // console.log("[Server] Request received for /api/get-app-path"); // Debug
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ appPath: APP_BASE_PATH }));
        } else {
            // console.log(`[Server] 404 Not Found: ${method} ${url}`); // Debug
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    });

    mainServer.listen(SERVER_PORT, 'localhost', () => {
        //console.log(`\nBackend server listening on http://localhost:${SERVER_PORT}`);
        console.log(`Base path for files: ${APP_BASE_PATH}`);
        // Initial config check message moved to mainMenu
        mainMenu(); // Start the interactive menu
    });

    mainServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`\nFATAL ERROR: Port ${SERVER_PORT} is already in use.`);
            console.error("Please close the application using the port (maybe another instance of this app?) or change SERVER_PORT in main.js.");
        } else {
            console.error('\nFATAL SERVER ERROR:', err);
        }
        process.exit(1); // Exit if server cannot start
    });
}

// --- REW Helper Functions (Keep as is, seem functional) ---
function isProcessRunning(processName) {
    return new Promise((resolve) => {
        const platform = os.platform();
        let cmd = '';
        // Be more specific with process names if possible
        if (platform === 'win32') {
            // Use WMIC for potentially more reliable results than tasklist if available
            // cmd = `WMIC process where "Name='${processName}'" get ProcessID`; // Alternative
            cmd = `tasklist /FI "IMAGENAME eq ${processName}" /NH`;
        } else if (platform === 'darwin') {
            // Use pgrep with -f to match full command line, more specific for Java apps like REW
            // Escape special characters if processName could contain them
            const escapedName = processName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            cmd = `pgrep -fli "${escapedName}"`; // Match case-insensitive, list full command, match pattern
        } else { // Linux/Other Unix
            const escapedName = processName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            cmd = `pgrep -fli "${escapedName}"`;
        }

        // console.log(`Executing process check: ${cmd}`); // Debug log
        exec(cmd, (error, stdout, stderr) => {
            // Handle errors differently per platform
            if (platform === 'win32') {
                // tasklist outputs "INFO: No tasks running..." if not found, stdout is not empty on failure.
                // Check if stdout *contains* the process name. Error object might be null even if not found.
                resolve(stdout.toLowerCase().includes(processName.toLowerCase()));
            } else { // macOS, Linux
                // pgrep exits with non-zero status if not found, error object will be set. stdout empty.
                if (error) {
                    resolve(false); // Process not found
                } else {
                    resolve(stdout.trim().length > 0); // Process found if stdout has content
                }
            }
            // Ignore stderr for this check generally
            // if (stderr) { console.warn(`Process check stderr: ${stderr}`); }
        });
    });
}

function findRewPath() {
    const platform = os.platform();
    const commonPaths = [];

    if (platform === 'win32') {
        // Environment variables are more reliable than hardcoded C: drive
        const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        commonPaths.push(path.join(progFiles, 'REW', 'roomeqwizard.exe'));
        commonPaths.push(path.join(progFilesX86, 'REW', 'roomeqwizard.exe'));
        // Check user-specific install location? (Less common for REW)
        // const localAppData = process.env['LOCALAPPDATA'];
        // if (localAppData) commonPaths.push(path.join(localAppData, 'Programs', 'REW', 'roomeqwizard.exe'));
    } else if (platform === 'darwin') {
        commonPaths.push('/Applications/REW.app/Contents/MacOS/roomeqwizard'); // Executable path
        commonPaths.push('/Applications/REW.app'); // .app bundle path (for using 'open')
        // User applications folder
        const home = os.homedir();
        commonPaths.push(path.join(home, 'Applications/REW.app/Contents/MacOS/roomeqwizard'));
        commonPaths.push(path.join(home, 'Applications/REW.app'));
    } else { // Linux
        console.warn("Automatic REW path detection on Linux is limited. Checking common PATH locations.");
        // Returning just the command name relies on it being in the system's PATH
        return 'roomeqwizard';
    }

    console.log("Checking common REW installation paths...");
    for (const p of commonPaths) {
        // console.log(`Checking: ${p}`); // Debug
        if (fs.existsSync(p)) {
             // On macOS, return the .app path for 'open' command if it exists, otherwise return executable path
             if (platform === 'darwin') {
                  if (p.endsWith('.app')) {
                      console.log(`Found REW application bundle: ${p}`);
                      return p; // Return .app path
                  } else if (fs.existsSync(p.replace('/Contents/MacOS/roomeqwizard', ''))) { // Check if corresponding .app exists
                      const appPath = p.replace('/Contents/MacOS/roomeqwizard', '');
                      console.log(`Found REW executable, using corresponding bundle: ${appPath}`);
                      return appPath; // Prefer .app path if found
                  } else {
                      console.log(`Found REW executable directly: ${p}`);
                      return p; // Return direct executable path as fallback
                  }
             } else { // Windows
                console.log(`Found REW executable: ${p}`);
                return p; // Return .exe path
             }
        }
    }

    // If Linux or path check failed
    if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
        console.log("REW not found in common paths. Assuming 'roomeqwizard' is in PATH.");
        return 'roomeqwizard'; // Rely on PATH for Linux/Unix
    }

    console.log("REW executable not found in standard locations.");
    return null; // Indicate not found on Win/Mac if checks fail
}


function launchRew(rewPath, memoryArg = "-Xmx4096m") { // Default 4GB memory
    return new Promise((resolve) => {
        const platform = os.platform();
        let cmd = '';
        let args = [];
        const apiArg = '-api'; // Argument to enable REW API server

        console.log(`Attempting to launch REW with API enabled from: ${rewPath}`);

        try {
            if (platform === 'win32') {
                // Need to handle spaces in path correctly, quoting is tricky with spawn
                // Using shell: true can help, but quoting the command itself is safer.
                cmd = `"${rewPath}"`; // Quote the executable path
                args = [memoryArg, apiArg];
                // Spawn directly, using shell=true to handle path quoting if needed
                 const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: true });
                 child.on('error', (err) => {
                    console.error(`Error launching REW (Win32): ${err.message}`);
                    resolve(false); // Indicate launch failure
                 });
                 child.unref(); // Allow parent process to exit independently
                 console.log("REW launch command executed (Win32).");
                 resolve(true); // Indicate launch attempt initiated

            } else if (platform === 'darwin') {
                 if (rewPath.endsWith('.app')) {
                    // Use 'open' for .app bundles
                    cmd = 'open';
                    // Pass arguments to the application via --args
                    args = ['-a', rewPath, '--args', memoryArg, apiArg];
                 } else {
                     // Launch executable directly if path is not .app
                     cmd = rewPath; // Assume executable path
                     args = [memoryArg, apiArg];
                 }
                  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' }); // No shell needed typically
                  child.on('error', (err) => {
                    console.error(`Error launching REW (macOS): ${err.message}`);
                    resolve(false);
                  });
                  child.unref();
                  console.log("REW launch command executed (macOS).");
                  resolve(true);

            } else { // Linux/Other
                cmd = rewPath; // Assumes 'roomeqwizard' or full path
                args = [memoryArg, apiArg];
                 const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
                 child.on('error', (err) => {
                    console.error(`Error launching REW (Linux/Other): ${err.message}`);
                    // Provide hint if command not found
                    if (err.code === 'ENOENT') {
                         console.error(`Hint: Ensure '${rewPath}' is executable and in your system's PATH.`);
                    }
                    resolve(false);
                 });
                 child.unref();
                 console.log("REW launch command executed (Linux/Other).");
                 resolve(true);
            }

        } catch (err) {
             // Catch synchronous errors during spawn setup
             console.error(`Exception trying to launch REW: ${err.message}`);
             resolve(false);
        }
    });
}

function checkRewApi(port = rewApiPort, timeout = 2000) {
    return new Promise((resolve) => {
        const options = {
            // --- CHANGE THIS ---
            // hostname: 'localhost',
            hostname: '127.0.0.1', // Use explicit IPv4 loopback
            // --- END CHANGE ---
            port: port,
            path: '/version',
            method: 'GET',
            timeout: timeout,
        };

        // console.log(`[checkRewApi] Attempting GET http://127.0.0.1:${port}/version...`); // Updated log

        const req = http.request(options, (res) => {
            let responseBody = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { responseBody += chunk; });

            res.on('end', () => {
                if (res.statusCode === 200) {
                    // console.log(`[checkRewApi] Success: Status 200.`);
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
    console.log("\n--- Checking REW Status & API Availability ---");
    const platform = os.platform();
    // Determine the most likely process name REW uses
    // Note: On macOS, the process seen by pgrep might be 'java' if launched certain ways,
    // but checking for 'REW' in the command line args (-fli) is usually better.
    // For simplicity, we'll use a base name and rely on the command line matching in isProcessRunning.
    const procNameBase = platform === 'win32' ? 'roomeqwizard.exe' : 'REW'; // Base name for checks

    console.log(`Checking if REW process (${procNameBase}) is running...`);
    let isRunning = await isProcessRunning(procNameBase); // Check using the base name

    // On macOS, if 'REW' isn't found, check for 'java' process with REW args as a fallback
    if (!isRunning && platform === 'darwin') {
        console.log("REW process not found, checking for Java process running REW...");
        isRunning = await isProcessRunning("java.*roomeqwizard"); // Regex-like pattern for pgrep
    }

    console.log(`Is REW process running? ${isRunning}`);

    let isApiListening = false;
    if (isRunning) {
        console.log(`REW process detected. Checking API status on port ${rewApiPort}...`);
        isApiListening = await checkRewApi(rewApiPort); // Use HTTP check primarily
        if (!isApiListening) {
             // Optional: Try TCP port check as a fallback? Might be misleading.
             // console.log("HTTP API check failed, trying basic TCP port check...");
             // const isPortOpen = await checkRewApiPortOpen(rewApiPort);
             // console.log(`Is TCP port ${rewApiPort} open? ${isPortOpen}`);
             // if (isPortOpen) console.warn("Warning: TCP port is open, but HTTP API check failed. REW might be starting or API misconfigured.");
        }
    }

    if (isRunning && isApiListening) {
        console.log("REW is running and its API server responded successfully. Good to go!");
        return true; // Everything looks ready
    }

    // --- Handle cases where REW is not ready ---

    if (isRunning && !isApiListening) {
        // REW is running, but API isn't responding correctly
        console.warn(`REW process is running, but the API on port ${rewApiPort} did not respond correctly.`);
        console.warn("Possible reasons: REW is still starting up, API server is disabled (needs '-api' launch flag or setting), firewall blocking, or different API port configured in REW.");
         const { proceedAnyway } = await inquirer.prompt([{
             type: 'confirm',
             name: 'proceedAnyway',
             message: `REW seems running, but the API isn't ready. Continue to open A1 Evo anyway? (May not function correctly without REW API)`,
             default: false // Default to no, safer
         }]);
         return proceedAnyway; // Return user's choice
    }

    // REW is not running
    console.log("REW process is not running.");
    const rewPath = findRewPath(); // Try to find REW installation

    if (!rewPath) {
        // Cannot find REW automatically
        console.error("Could not automatically find REW installation in common locations.");
        console.log(`Please start REW manually.`);
        console.log("IMPORTANT: Ensure REW's API server is enabled. This might require:");
        console.log("  - Launching REW from a terminal/command prompt with the '-api' flag (e.g., roomeqwizard.exe -api)");
        console.log("  - Or, check REW Preferences/Settings for an API server option (availability depends on REW version).");
         const { proceedManual } = await inquirer.prompt([{
             type: 'confirm',
             name: 'proceedManual',
             message: `Could not find REW automatically. Please start it manually with its API enabled.\nProceed to open A1 Evo once you believe REW is ready?`,
             default: true
         }]);
        // If user says yes, we assume they will start it manually.
        return proceedManual;
    }

    // Found REW path, offer to launch it
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

    // Attempt to launch REW
    const memoryArg = "-Xmx4096m"; // Example memory setting
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

    // Wait for REW to potentially start up
    const waitTime = 8000; // Increased wait time (8 seconds)
    console.log(`REW launch command sent. Waiting ${waitTime / 1000} seconds for REW and its API server to initialize...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));

    // Check API status again after waiting
    console.log("Checking REW API status again after launch attempt...");
    const isApiListeningAfterLaunch = await checkRewApi(rewApiPort);

    if (isApiListeningAfterLaunch) {
        console.log("REW launched and API server responded successfully. Proceeding...");
        return true; // Success!
    } else {
        console.error(`Launched REW, but the API on port ${rewApiPort} did not respond correctly within the wait time.`);
        console.error("Ensure REW launched successfully and that the '-api' flag or internal setting is enabling the API server.");
        console.error("Also check firewalls or if REW is configured to use a different API port.");
         const { proceedFail } = await inquirer.prompt([{
             type: 'confirm',
             name: 'proceedFail',
             message: `Started REW, but couldn't confirm API status on port ${rewApiPort}.\nContinue to open A1 Evo anyway? (May not function correctly)`,
             default: false // Default to no
         }]);
        return proceedFail;
    }
}

// --- SIGINT Handler (Keep as is) ---
process.on('SIGINT', () => {
    console.log("\nCtrl+C detected. Shutting down...");
    if (mainServer) {
        mainServer.close(() => {
            console.log("Server closed.");
            process.exit(0);
        });
         // Force exit if close hangs
        setTimeout(() => {
             console.log("Server close timed out. Forcing exit.");
             process.exit(1);
        }, 2000);
    } else {
        process.exit(0);
    }
});

// --- Start the Application ---
initializeApp();
