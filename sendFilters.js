const fs = require('fs');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const http = require('http');
const {URL} = require('url');
const readline = require('readline');

/* ────────────────────────────────────────────── CONFIGURATION ────────────────────────────────────────────── */
const CONFIG = {
  files: { filters: 'filter.oca' },
  target: { ip: null, port: 1256 },
  targetCurves: ['00', '01'],
  sampleRates: ['00', '01', '02'],
  timeouts: {
    connect: 5000,
    command: 15000,
    finalize: 30000,
    enterAudyssey: 2000,
    nonAckPacket: 150
  }
};

const CMD_SET_COEFDT_HEX = '5345545f434f45464454'; // "SET_COEFDT"
const FLOATS_PER_FULL_PACKET_PAYLOAD = 128;
const BYTES_PER_FLOAT = 4;
const FULL_PACKET_PAYLOAD_BYTES = FLOATS_PER_FULL_PACKET_PAYLOAD * BYTES_PER_FLOAT; // 512
const FIRST_PACKET_INFO_BYTES = 4;
const FIRST_PACKET_FLOAT_PAYLOAD_COUNT = 127;
const CHECKSUM_LENGTH = 1;
const DECIMATION_FACTOR = 4;

/* ────────────────────────────────────────────── DECIMATION FILTER TAP COEFFICIENTS ────────────────────────────────────────────── */
const decFilterXT32Sub29_taps = [
  -0.0000068090826, -4.5359936E-8, 0.00010496614, 0.0005359394, 0.0017366897, 0.0043950975,
  0.00936928, 0.017480986, 0.029199528, 0.04430621, 0.061674833, 0.07929655,
  0.094606727, 0.1050576, 0.10877161, 0.1050576, 0.094606727, 0.07929655,
  0.061674833, 0.04430621, 0.029199528, 0.017480986, 0.00936928, 0.0043950975,
  0.0017366897, 0.0005359394, 0.00010496614, -4.5359936E-8, -0.0000068090826
];

const decFilterXT32Sub37_taps = [
  -0.000026230078, -0.00013839548, -0.00045447858, -0.0011429883, -0.0023770225,
  -0.0042346125, -0.0065577077, -0.0088115167, -0.010010772, -0.008782894,
  -0.0036095164, 0.0067711435, 0.02289046, 0.04414973, 0.06865209, 0.093375608,
  0.11469775, 0.12916237, 0.1342851, 0.12916237, 0.11469775, 0.093375608,
  0.06865209, 0.04414973, 0.02289046, 0.0067711435, -0.0036095164, -0.008782894,
  -0.010010772, -0.0088115167, -0.0065577077, -0.0042346125, -0.0023770225,
  -0.0011429883, -0.00045447858, -0.00013839548, -0.000026230078
];

const decFilterXT32Sub93_taps = [
  0.000004904671, 0.000016451735, 0.000035466823, 0.000054780343, 0.000057436635,
  0.000019883537, -0.00007663135, -0.00022867938, -0.0003953652, -0.0004970615,
  -0.00043803814, -0.00015296187, 0.00033801072, 0.00089421676, 0.0012704487,
  0.0011992522, 0.0005233042, -0.00067407207, -0.0020127299, -0.0028939669,
  -0.0027228948, -0.0012104996, 0.0013740772, 0.004148222, 0.005850492,
  0.005338624, 0.0021824592, -0.0029139882, -0.0081179589, -0.011018342,
  -0.0096052159, -0.0033266835, 0.0062539442, 0.015607043, 0.020322932,
  0.016872915, 0.0044270838, -0.014038938, -0.031958703, -0.040876575,
  -0.033219177, -0.0052278917, 0.04104016, 0.097502038, 0.15189469,
  0.19119503, 0.20552149, 0.19119503, 0.15189469, 0.097502038, 0.04104016,
  -0.0052278917, -0.033219177, -0.040876575, -0.031958703, -0.014038938,
  0.0044270838, 0.016872915, 0.020322932, 0.015607043, 0.0062539442,
  -0.0033266835, -0.0096052159, -0.011018342, -0.0081179589, -0.0029139882,
  0.0021824592, 0.005338624, 0.005850492, 0.004148222, 0.0013740772,
  -0.0012104996, -0.0027228948, -0.0028939669, -0.0020127299, -0.00067407207,
  0.0005233042, 0.0011992522, 0.0012704487, 0.00089421676, 0.00033801072,
  -0.00015296187, -0.00043803814, -0.0004970615, -0.0003953652, -0.00022867938,
  -0.00007663135, 0.000019883537, 0.000057436635, 0.000054780343, 0.000035466823,
  0.000016451735, 0.000004904671
];

const decFilterXT32Sat129_taps = [
  0.0000043782347, 0.000014723354, 0.000032770109, 0.000054528296, 0.000068608439,
  0.00005722275, 0.0000025561833, -0.0001022896, -0.00024198946, -0.0003741896,
  -0.0004376953, -0.00037544663, -0.00016613922, 0.00014951751, 0.00046477153,
  0.000636138, 0.0005427991, 0.00015503204, -0.0004217047, -0.00095836946,
  -0.0011810855, -0.00089615857, -0.00010969268, 0.0009218459, 0.0017551293,
  0.0019349628, 0.0012194271, -0.00024770317, -0.0019181528, -0.0030198381,
  -0.0028912309, -0.0013345525, 0.0011865027, 0.0036375371, 0.0048077558,
  0.0038727189, 0.00087827817, -0.0031111876, -0.0063393954, -0.0070888256,
  -0.0045305756, 0.00070328976, 0.006557314, 0.010292898, 0.009696761,
  0.0042538098, -0.0042899773, -0.012354134, -0.01590999, -0.012335026,
  -0.0019397299, 0.0116079, 0.022352377, 0.024387382, 0.014624386,
  -0.0051601734, -0.028005365, -0.043577183, -0.04166761, -0.016186262,
  0.031879943, 0.09379751, 0.15517053, 0.20020825, 0.21674114,
  0.20020825, 0.15517053, 0.09379751, 0.031879943, -0.016186262,
  -0.04166761, -0.043577183, -0.028005365, -0.0051601734, 0.014624386,
  0.024387382, 0.022352377, 0.0116079, -0.0019397299, -0.012335026,
  -0.01590999, -0.012354134, -0.0042899773, 0.0042538098, 0.009696761,
  0.010292898, 0.006557314, 0.00070328976, -0.0045305756, -0.0070888256,
  -0.0063393954, -0.0031111876, 0.00087827817, 0.0038727189, 0.0048077558,
  0.0036375371, 0.0011865027, -0.0013345525, -0.0028912309, -0.0030198381,
  -0.0019181528, -0.00024770317, 0.0012194271, 0.0019349628, 0.0017551293,
  0.0009218459, -0.00010969268, -0.00089615857, -0.0011810855, -0.00095836946,
  -0.0004217047, 0.00015503204, 0.0005427991, 0.000636138, 0.00046477153,
  0.00014951751, -0.00016613922, -0.00037544663, -0.0004376953, -0.0003741896,
  -0.00024198946, -0.0001022896, 0.0000025561833, 0.00005722275, 0.000068608439,
  0.000054528296, 0.000032770109, 0.000014723354, 0.0000043782347
];

const decFilterSat129_custom = [0.00000440413,
0.000014736531,
0.0000327827,
0.00005453997,
0.0000686138,
0.0000572204,
0.000002544775,
-0.000102308986,
-0.00024201462,
-0.0003742095,
-0.00043771017,
-0.00037544256,
-0.00016612867,
0.00014953918,
0.00046478605,
0.00063614483,
0.00054278015,
0.00015500216,
-0.00042174867,
-0.0009584045,
-0.0011810908,
-0.0008961293,
-0.000109627515,
0.000921918,
0.0017551685,
0.0019349454,
0.0012193462,
-0.00024781885,
-0.0019182619,
-0.0030198863,
-0.0028911754,
-0.0013344138,
0.0011866783,
0.0036376682,
0.00480776,
0.003872565,
0.00087801175,
-0.0031114663,
-0.006339546,
-0.007088764,
-0.0045302818,
0.0007037132,
0.0065576863,
0.010293026,
0.0096965395,
0.00425328,
-0.004290619,
-0.012354594,
-0.015910003,
-0.012334503,
-0.0019388128,
0.011608851,
0.022352902,
0.024387132,
0.014623294,
-0.005161803,
-0.028006893,
-0.043577828,
-0.041666728,
-0.016183635,
0.03188396,
0.0938021,
0.15517454,
0.20021066,
0.21674126,
0.20020607,
0.15516667,
0.09379302,
0.031875927,
-0.016188951,
-0.0416686,
-0.043576654,
-0.028003918,
-0.0051585813,
0.014625476,
0.02438765,
0.022351885,
0.011606982,
-0.001940619,
-0.012335537,
-0.015909975,
-0.01235368,
-0.0042893398,
0.004254332,
0.009696979,
0.010292766,
0.006556938,
0.00070286024,
-0.004530872,
-0.007088893,
-0.006339238,
-0.0031109129,
0.00087854394,
0.0038728632,
0.0048077335,
0.0036373856,
0.0011863019,
-0.0013347201,
-0.0028913007,
-0.003019803,
-0.0019180495,
-0.00024758538,
0.0012195057,
0.0019349803,
0.001755088,
0.000921772,
-0.00010977233,
-0.00089620793,
-0.0011810914,
-0.00095834123,
-0.00042166057,
0.00015507352,
0.0005428141,
0.00063614134,
0.0004647574,
0.0001494931,
-0.00016616723,
-0.00037546104,
-0.0004377067,
-0.00037419182,
-0.00024199538,
-0.00010229232,
0.0000025530417,
0.000057224257,
0.000068608606,
0.000054535307,
0.000032785134,
0.000014737208,
0.0000044028516];

/* ────────────────────────────────────────────── POLYPHASE DECOMPOSITION & FILTER CONFIGURATION ────────────────────────────────────────────── */
const decomposeFilter = (filterTaps, M) => {
  const L = filterTaps.length;
  const phases = Array.from({ length: M }, () => []);
  for (let p = 0; p < M; p++) {
    for (let i = 0;; i++) {
      const n = i * M + p;
      if (n >= L) break;
      phases[p].push(filterTaps[n]);
    }
  }
  return phases;
};

const polyphaseDecFilterXT32Sub29 = decomposeFilter(decFilterXT32Sub29_taps, DECIMATION_FACTOR);
const polyphaseDecFilterXT32Sub37 = decomposeFilter(decFilterXT32Sub37_taps, DECIMATION_FACTOR);
const polyphaseDecFilterXT32Sub93 = decomposeFilter(decFilterXT32Sub93_taps, DECIMATION_FACTOR);
const polyphaseDecFilterXT32Sat129 = decomposeFilter(decFilterXT32Sat129_taps, DECIMATION_FACTOR);

// Extra float trimming for non-XT32 filters
const EXPECTED_NON_XT32_FLOAT_COUNTS = {
  'XT': { speaker: 511, sub: 511 },
  'MultEQ': { speaker: 127, sub: 511 }
};

const filterConfigs = {
  xt32Sub: {
    description: "MultEQ XT32 Subwoofer",
    inputLength: 0x3EB7,
    outputLength: 0x2C0,
    bandLengths: [0x60, 0x60, 0x100, 0xEF],
    decFiltersInfo: [
      { phases: polyphaseDecFilterXT32Sub29, originalLength: decFilterXT32Sub29_taps.length },
      { phases: polyphaseDecFilterXT32Sub37, originalLength: decFilterXT32Sub37_taps.length },
      { phases: polyphaseDecFilterXT32Sub93, originalLength: decFilterXT32Sub93_taps.length }
    ],
    delayComp: [true, true, true]
  },
  xt32Speaker: {
    description: "MultEQ XT32 Speaker",
    inputLength: 0x3FC1,
    outputLength: 0x3FF,
    bandLengths: [0x100, 0x100, 0x100, 0xEB],
    decFiltersInfo: [
      { phases: polyphaseDecFilterXT32Sat129, originalLength: decFilterXT32Sat129_taps.length },
      { phases: polyphaseDecFilterXT32Sat129, originalLength: decFilterXT32Sat129_taps.length },
      { phases: polyphaseDecFilterXT32Sat129, originalLength: decFilterXT32Sat129_taps.length }
    ],
    delayComp: [true, true, true]
  }
};

const channelByteTable = {
  FL: { eq2: 0x00, neq2: 0x00, griffin: 0x00 },
  C: { eq2: 0x01, neq2: 0x01, griffin: 0x01 },
  FR: { eq2: 0x02, neq2: 0x02, griffin: 0x02 },
  FWR: { eq2: 0x15, neq2: 0x15, griffin: 0x15 },
  SRA: { eq2: 0x03, neq2: 0x03, griffin: 0x03 },
  SRB: { eq2: null, neq2: 0x07, griffin: null },
  SBR: { eq2: 0x07, neq2: 0x07, griffin: 0x07 },
  SBL: { eq2: 0x08, neq2: 0x08, griffin: 0x08 },
  SLB: { eq2: null, neq2: 0x0d, griffin: null },
  SLA: { eq2: 0x0c, neq2: 0x0c, griffin: 0x0c },
  FWL: { eq2: 0x1c, neq2: 0x1c, griffin: 0x1c },
  FHL: { eq2: 0x10, neq2: 0x10, griffin: 0x10 },
  CH: { eq2: 0x12, neq2: 0x12, griffin: 0x12 },
  FHR: { eq2: 0x14, neq2: 0x14, griffin: 0x14 },
  TFR: { eq2: 0x04, neq2: 0x04, griffin: 0x04 },
  TMR: { eq2: 0x05, neq2: 0x05, griffin: 0x05 },
  TRR: { eq2: 0x06, neq2: 0x06, griffin: 0x06 },
  SHR: { eq2: 0x16, neq2: 0x16, griffin: 0x16 },
  RHR: { eq2: 0x13, neq2: 0x17, griffin: 0x13 },
  TS: { eq2: 0x1d, neq2: 0x1d, griffin: 0x1d },
  RHL: { eq2: 0x11, neq2: 0x1a, griffin: 0x11 },
  SHL: { eq2: 0x1b, neq2: 0x1b, griffin: 0x1b },
  TRL: { eq2: 0x09, neq2: 0x09, griffin: 0x09 },
  TML: { eq2: 0x0a, neq2: 0x0a, griffin: 0x0a },
  TFL: { eq2: 0x0b, neq2: 0x0b, griffin: 0x0b },
  FDL: { eq2: 0x1a, neq2: 0x1a, griffin: 0x1a },
  FDR: { eq2: 0x17, neq2: 0x17, griffin: 0x17 },
  SDR: { eq2: 0x18, neq2: 0x18, griffin: 0x18 },
  BDR: { eq2: 0x18, neq2: 0x00, griffin: 0x1f },
  SDL: { eq2: 0x19, neq2: 0x19, griffin: 0x19 },
  BDL: { eq2: 0x19, neq2: 0x00, griffin: 0x20 },
  LFE: { eq2: 0x0d, neq2: 0x0d, griffin: 0x0d },
  SW1: { eq2: 0x0d, neq2: 0x0d, griffin: 0x0d },
  SW2: { eq2: 0x0e, neq2: 0x0e, griffin: 0x0e },
  SW3: { eq2: 0x21, neq2: 0x21, griffin: 0x21 },
  SW4: { eq2: 0x22, neq2: 0x22, griffin: 0x22 },
  SWMIX1:{eq2:0x0d,neq2:0x0d,griffin:0x0d},
  SWMIX2:{eq2:0x0e,neq2:0x0e,griffin:0x0e},
  SWMIX3:{eq2:0x21,neq2:0x21,griffin:0x21},
  SWMIX4:{eq2:0x22,neq2:0x22,griffin:0x22}
};

/* ────────────────────────────────────────────── UPnP DEVICE DISCOVERY ────────────────────────────────────────────── */

function sendTelnetCommands(ip, port = 23, lpf4LFE = 120) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let presetQueryTimeout;
    let selectedPreset = null;
    const commands = [];
    let hasHandledPreset = false;
    let commandsSent = false;
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    function proceedWithCommands() {
      if (commandsSent) return;
      commandsSent = true;
      
      if (selectedPreset) {
        commands.push(`SPPR ${selectedPreset}`);
      }
      commands.push('SSSWM LFE', 'SSSWO LFE', `SSLFL ${lpf4LFE}`);
      
      // Send commands with delay between each
      let commandIndex = 0;
      
      function sendNextCommand() {
        if (commandIndex >= commands.length) {
          //console.log('All commands sent, closing connection');
          client.end();
          resolve(); // ✅ Done
          return;
        }
        
        const command = commands[commandIndex];
        //console.log(`Sending command: ${command}`);
        client.write(command + '\r');
        
        // Wait for response before sending next command
        setTimeout(sendNextCommand, 500);
        commandIndex++;
      }
      
      // Start sending commands
      sendNextCommand();
    }
    
    client.connect(port, ip, () => {
      console.log(`Connected to ${ip}`);
      console.log('Checking AVR preset support...');
      client.write('SPPR ?\r');
      
      // Timeout if AVR doesn't respond
      presetQueryTimeout = setTimeout(() => {
        if (!hasHandledPreset) {
          console.log('AVR does not support multiple presets!');
          hasHandledPreset = true;
          proceedWithCommands();
        }
      }, 2000);
    });
    
    client.on('data', (data) => {
      const response = data.toString().trim();
      //console.log(`Received: ${response}`); // Add response logging
      
      if (!hasHandledPreset && response.startsWith('SPPR ') && ['1', '2'].includes(response.split(' ')[1])) {
        clearTimeout(presetQueryTimeout);
        hasHandledPreset = true;
        
        const preset = response.match(/SPPR\s*(\d+)/i)[1];
        console.log(`Your receiver is currently set to store new settings in Preset ${preset}`);
        
        rl.question('Select a preset to store your new calibration settings (1 or 2): ', (answer) => {
          if (answer === '1' || answer === '2') {
            selectedPreset = answer;
          } else {
            selectedPreset = '1';
            console.log('Invalid selection. Defaulting to Preset 1.');
          }
          
          console.log(`Using Preset ${selectedPreset} for new calibration settings.`);
          // Don't close rl yet - wait until we're done with commands
          proceedWithCommands();
        });
      } 
      // Add confirmation check for preset change
      else if (response.startsWith(`SPPR ${selectedPreset}`)) {
        console.log(`Preset successfully changed to ${selectedPreset}`);
      }
    });
    
    client.on('error', (err) => {
      rl.close();
      console.error('Telnet connection error:', err);
      reject(err);
    });
    
    client.on('close', () => {
      rl.close();
      //console.log('Telnet connection closed');
    });
  });
}

class UPNPDiscovery {
  constructor() {
    this.socket = dgram.createSocket('udp4');
    this.SSDP_MULTICAST_ADDR = '239.255.255.250';
    this.SSDP_PORT = 1900;
    this.SEARCH_TARGETS = ['ssdp:all', 'upnp:rootdevice'];
  }

  discover() {
    return new Promise((resolve) => {
      const devices = [];
      const discoveryTimeout = setTimeout(() => {
        this.socket.close();
        resolve(devices);
      }, 5000);

      this.socket.on('message', (msg, rinfo) => {
        const response = msg.toString();
        if (response.includes('HTTP/1.1 200 OK') && response.includes('LOCATION:')) {
          const locationMatch = response.match(/LOCATION:\s*(.+)/i);
          if (locationMatch) {
            this.fetchDeviceDescription(locationMatch[1])
              .then((deviceInfo) => {
                const device = { address: rinfo.address, port: rinfo.port, ...deviceInfo };
                if (!devices.some(d => d.address === device.address)) {
                  devices.push(device);
                }
              })
              .catch(console.error);
          }
        }
      });

      this.socket.bind(() => {
        this.socket.addMembership(this.SSDP_MULTICAST_ADDR);
        this.SEARCH_TARGETS.forEach(target => {
          const searchRequest = Buffer.from(
            'M-SEARCH * HTTP/1.1\r\n' +
            `HOST: ${this.SSDP_MULTICAST_ADDR}:${this.SSDP_PORT}\r\n` +
            'MAN: "ssdp:discover"\r\n' +
            'MX: 2\r\n' +
            `ST: ${target}\r\n\r\n`
          );
          this.socket.send(searchRequest, 0, searchRequest.length, this.SSDP_PORT, this.SSDP_MULTICAST_ADDR);
        });
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
        method: 'GET'
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const modelName = data.match(/<modelName>(.+?)<\/modelName>/);
            const manufacturer = data.match(/<manufacturer>(.+?)<\/manufacturer>/i);
            const friendlyName = data.match(/<friendlyName>(.+?)<\/friendlyName>/);
            resolve({
              modelName: modelName ? modelName[1] : 'Unknown Model',
              manufacturer: manufacturer ? manufacturer[1] : 'Unknown Manufacturer',
              friendlyName: friendlyName ? friendlyName[1] : 'Unknown Device',
              descriptionUrl: locationUrl
            });
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  static async interactiveDeviceSelection(devices) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\nDiscovered UPnP Devices:');
    devices.forEach((device, index) => {
      console.log(`[${index + 1}] ${device.manufacturer} ${device.modelName} (${device.address})`);
    });

    return new Promise((resolve) => {
      rl.question('\nEnter the number of the device you want to select (or press Enter to cancel): ', (answer) => {
        rl.close();
        const selectedIndex = parseInt(answer) - 1;
        resolve(selectedIndex >= 0 && selectedIndex < devices.length ? devices[selectedIndex] : null);
      });
    });
  }
}

/* ────────────────────────────────────────────── FILE & FILTER PROCESSING ────────────────────────────────────────────── */

async function selectOcaFile() {
  const currentDir = process.cwd();
  console.log(`Searching all calibration (.oca) files in: ${currentDir}`);

  // Get all .oca files in current directory
  const files = fs.readdirSync(currentDir)
    .filter(file => path.extname(file).toLowerCase() === '.oca');

  if (files.length === 0) {
    throw new Error('No .oca files found in the current directory!');
  }

  // Sort by modification time (newest first)
  const sortedFiles = files
    .map(file => ({
      name: file,
      path: path.join(currentDir, file),
      mtime: fs.statSync(path.join(currentDir, file)).mtime
    }))
    .sort((a, b) => b.mtime - a.mtime);

  // Display file list
  console.log('\nAvailable calibration (.oca) files:');
  sortedFiles.forEach((file, index) => {
    console.log(`${index + 1}: ${file.name} (${file.mtime.toLocaleString()})`);
  });
  console.log(`${sortedFiles.length + 1}: Enter manual path`);

  // Get user selection
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question('\nSelect calibration file number to transfer (or press Enter for most recent): ', resolve));
  rl.close();

  // Handle selection
  if (answer.trim() === '') {
    return sortedFiles[0].path;  // Default to most recent
  }

  const choice = parseInt(answer);
  if (choice === sortedFiles.length + 1) {
    const rlPath = readline.createInterface({ input: process.stdin, output: process.stdout });
    const manualPath = await new Promise(resolve => rlPath.question('Enter full path to .oca file: ', resolve));
    rlPath.close();
    
    if (!fs.existsSync(manualPath)) {
      throw new Error(`File not found: ${manualPath}`);
    }
    return manualPath;
  }

  if (choice >= 1 && choice <= sortedFiles.length) {
    return sortedFiles[choice - 1].path;
  }

  throw new Error(`Invalid selection: ${answer}`);
}

async function main() {
  try {
    const selectedFile = await selectOcaFile();
    console.log(`Selected file: ${selectedFile}`);
    
    // Update CONFIG with the full path
    if (typeof CONFIG !== 'undefined') {
      CONFIG.files.filters = selectedFile;
    }
    
    return selectedFile;
  } catch (error) {
    console.error('Error in file selection:', error.message);
    process.exit(1);
  }
}

const polyphaseDecimate = (signal, phases, M, originalFilterLength) => {
  const signalLen = signal.length;
  const L = originalFilterLength;
  if (signalLen === 0 || L === 0 || M <= 0 || !phases || phases.length !== M) return [];
  const convolvedLength = signalLen + L - 1;
  const outputLen = Math.ceil(convolvedLength / M);
  if (outputLen <= 0) return [];
  const output = new Array(outputLen).fill(0);
  for (let k = 0; k < outputLen; k++) {
    let y_k = 0;
    for (let p = 0; p < M; p++) {
      const currentPhase = phases[p];
      for (let i = 0; i < currentPhase.length; i++) {
        const inIndex = (k - i) * M - p;
        if (inIndex >= 0 && inIndex < signalLen) {
          y_k += currentPhase[i] * signal[inIndex];
        }
      }
    }
    output[k] = y_k;
  }
  return output;
};

const generateWindow = (len, type) => {
  const c1 = [0.5, 0.42, 0.54, 0.54, 0.54, 0.54, 0.54, 1.0];
  const c2 = [0.5, 0.5, 0.46, 0.46, 0.46, 0.46, 0.46, 0.0];
  const c3 = [0.0, 0.08, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
  const typeIndex = type - 1;
  const a = typeIndex >= 0 && typeIndex < c1.length ? c1[typeIndex] : 0.54;
  const b = typeIndex >= 0 && typeIndex < c2.length ? c2[typeIndex] : 0.46;
  const c = typeIndex >= 0 && typeIndex < c3.length ? c3[typeIndex] : 0.0;
  if (len <= 0) return [];
  const window = new Array(len);
  const factor = 1.0 / (len > 1 ? len - 1 : 1);
  const pi2 = 2 * Math.PI;
  const pi4 = 4 * Math.PI;
  for (let i = 0; i < len; i++) {
    const t = i * factor;
    window[i] = (Math.cos(pi4 * t) * c + a) - Math.cos(pi2 * t) * b;
  }
  return window;
};

const calculateMrate3Filter = (currentResidual, bandIdx, config) => {
  const bandLen = config.bandLengths[bandIdx];
  const filterInfo = config.decFiltersInfo[bandIdx];
  const useDelayComp = config.delayComp[bandIdx];
  const processedBand = new Array(bandLen).fill(0);
  if (!filterInfo || !filterInfo.phases) {
    throw new Error(`Polyphase filter info missing for band ${bandIdx}.`);
  }
  const decFilterPhases = filterInfo.phases;
  const decFilterOriginalLen = filterInfo.originalLength;
  if (decFilterOriginalLen === 0) {
    throw new Error(`Decimation filter missing or empty for non-zero length band ${bandIdx}.`);
  }
  const delay = useDelayComp ? Math.floor((decFilterOriginalLen * 3 - 3) / 2) : 0;
  const winLen = bandLen - delay;
  if (winLen < 0) throw new Error(`Calculated window length is negative for band ${bandIdx}`);
  const winAlloc = winLen * 2 + 3;
  const fullWindow = generateWindow(winAlloc, 1);
  for (let i = 0; i < delay; i++) {
    if (i < currentResidual.length) processedBand[i] = currentResidual[i];
  }
  const windowOffset = Math.floor(winAlloc / 2) + 1;
  for (let i = 0; i < winLen; i++) {
    const residualIdx = delay + i;
    if (residualIdx < currentResidual.length && windowOffset + i < fullWindow.length) {
      processedBand[residualIdx] = currentResidual[residualIdx] * fullWindow[windowOffset + i];
    } else if (residualIdx >= currentResidual.length) {
      break;
    }
  }
  const residualForDecimation = [];
  for (let i = 0; i < winLen; i++) {
    const residualIdx = delay + i;
    residualForDecimation.push(residualIdx < currentResidual.length ? currentResidual[residualIdx] - processedBand[residualIdx] : 0.0);
  }
  for (let i = bandLen; i < currentResidual.length; i++) {
    residualForDecimation.push(currentResidual[i]);
  }
  const decimatedResidual = polyphaseDecimate(residualForDecimation, decFilterPhases, DECIMATION_FACTOR, decFilterOriginalLen);
  const updatedResidual = decimatedResidual.map(v => v * 4.0);
  return { processedBand, updatedResidual };
};

const calculateMultirate = (impulseResponse, config) => {
  const finalOutput = new Array(config.outputLength).fill(0);
  let currentResidual = [...impulseResponse];
  let outputWriteOffset = 0;
  const numBands = config.bandLengths.length;
  const bandsToProcess = numBands - 1;
  for (let bandIdx = 0; bandIdx < bandsToProcess; bandIdx++) {
    const { processedBand, updatedResidual } = calculateMrate3Filter(currentResidual, bandIdx, config);
    const currentBandLen = config.bandLengths[bandIdx];
    for (let i = 0; i < currentBandLen; i++) {
      const outputIdx = outputWriteOffset + i;
      if (outputIdx < finalOutput.length) {
        finalOutput[outputIdx] = i < processedBand.length ? processedBand[i] : 0.0;
      } else {
        console.warn(`Output buffer overflow writing band ${bandIdx}`);
        break;
      }
    }
    outputWriteOffset += currentBandLen;
    currentResidual = updatedResidual;
  }
  const lastBandIdx = numBands - 1;
  const lastBandLen = config.bandLengths[lastBandIdx];
  for (let i = 0; i < lastBandLen; i++) {
    const outputIdx = outputWriteOffset + i;
    if (outputIdx < finalOutput.length) {
      finalOutput[outputIdx] = i < currentResidual.length ? currentResidual[i] : 0.0;
    } else {
      console.warn(`Output buffer overflow writing last band ${lastBandIdx}`);
      break;
    }
  }
  return finalOutput;
};

function convertXT32(floats) {
  const inputLength = floats.length;
  let configToUse = null;
  let expectedOutputLength = 0;
  if (inputLength === filterConfigs.xt32Speaker.inputLength) {
    configToUse = filterConfigs.xt32Speaker;
    expectedOutputLength = filterConfigs.xt32Speaker.outputLength;
  } else if (inputLength === filterConfigs.xt32Sub.inputLength) {
    configToUse = filterConfigs.xt32Sub;
    expectedOutputLength = filterConfigs.xt32Sub.outputLength;
  }
  if (configToUse) {
    try {
      const mangledFilter = calculateMultirate(floats, configToUse);
      if (mangledFilter.length !== expectedOutputLength) {
        console.warn(`WARNING: Decimation output length (${mangledFilter.length}) does not match expected (${expectedOutputLength}).`);
      }
      return mangledFilter;
    } catch (error) {
      console.error(`ERROR during calculateMultirate for ${inputLength} floats:`, error);
      console.warn(`Returning original filter due to decimation error.`);
      return floats;
    }
  } else {
    return floats;
  }
}

function buildPacketConfig(totalFloats) {
  if (totalFloats <= 0) throw new Error(`Invalid totalFloats: ${totalFloats}`);
  const firstPacketFloatPayload = 127;
  const midPacketFloatPayload = 128;
  let packetCount, firstPacketActualFloats, lastPacketFloats, fullPacketCount;
  if (totalFloats <= firstPacketFloatPayload) {
    packetCount = 1;
    firstPacketActualFloats = totalFloats;
    lastPacketFloats = totalFloats;
    fullPacketCount = 1;
  } else {
    firstPacketActualFloats = firstPacketFloatPayload;
    const remainingFloats = totalFloats - firstPacketActualFloats;
    const numAdditionalPackets = Math.ceil(remainingFloats / midPacketFloatPayload);
    packetCount = 1 + numAdditionalPackets;
    const remainder = remainingFloats % midPacketFloatPayload;
    lastPacketFloats = remainder === 0 ? midPacketFloatPayload : remainder;
    fullPacketCount = 1 + Math.floor(remainingFloats / midPacketFloatPayload);
  }
  const fullPacketCountField = fullPacketCount.toString(16).padStart(2, '0');
  return {
    totalFloats,
    packetCount,
    fullPacketCountField,
    firstPacketFloats: firstPacketActualFloats,
    midPacketFloats: midPacketFloatPayload,
    lastPacketFloats
  };
}

const floatToHex = float => {
  const buf = Buffer.alloc(BYTES_PER_FLOAT);
  buf.writeFloatLE(float);
  return buf.toString('hex');
};

function floatToFixed32HexLE(f) {
  let fixedInt;
  const isNegative = f < 0.0;
  const absF = Math.abs(f);
  if (absF >= 1.0) {
    fixedInt = 0x7FFFFFFF;
  } else {
    fixedInt = Math.round(absF * 2147483648.0);
    if (fixedInt > 0x7FFFFFFF) fixedInt = 0x7FFFFFFF;
  }
  if (isNegative) {
    if (absF >= 1.0) {
      fixedInt = -2147483648;
    } else if (fixedInt === 0) {
      fixedInt = 0;
    } else {
      fixedInt = -fixedInt;
    }
  }
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(fixedInt, 0);
  return buf.toString('hex');
}

const addCheckSum = hex => {
  if (hex.length % 2 !== 0) throw new Error(`Hex string for checksum must have even length: ${hex.slice(0, 10)}...`);
  const checksum = [...hex.matchAll(/../g)]
    .reduce((sum, [byte]) => (sum + parseInt(byte, 16)) & 0xFF, 0)
    .toString(16)
    .padStart(2, '0');
  return Buffer.from(hex + checksum, 'hex');
};

function getChannelTypeByte(commandId, multEqType, isGriffin = false) {
  const entry = channelByteTable[commandId];
  if (!entry) throw new Error(`Unknown channel commandId: ${commandId}`);

  // If Griffin flag is set, use the griffin value if available.
  if (isGriffin && entry.griffin !== null) return entry.griffin;
  if (isGriffin && entry.griffin === null) 
    console.warn(`⚠ Griffin channel byte requested but not available for ${commandId}, falling back...`);

  // For XT32 devices, use the eq2 field.
  if (multEqType === 'XT32' && entry.eq2 !== null) return entry.eq2;

  // For XT or basic EQ devices, use the neq2 field.
  if ((multEqType === 'XT' || multEqType === 'MultEQ') && entry.neq2 !== null) return entry.neq2;

  // Fallback: return whichever one is available.
  if (entry.neq2 !== null) return entry.neq2;
  if (entry.eq2 !== null) return entry.eq2;

  throw new Error(`No suitable channel byte mapping found for ${commandId} with MultEQ type ${multEqType}`);
}

const createCommandSender = socket => {
  return async (hex, label, { timeout = CONFIG.timeouts.command, addChecksum = true, expectAck = true } = {}) => {
    const packet = addChecksum ? addCheckSum(hex) : Buffer.from(hex, 'hex');
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let timer = null;
      let cleanedUp = false;

      const cleanup = (success, reason, nack = false) => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearTimeout(timer);
        socket.off('data', handler);
        socket.off('error', errorHandler);
        if (nack) console.log(`✗ Failed: ${label} - ${reason}`);
        success ? resolve(true) : reject(new Error(`${label}: ${reason}`));
      };

      const handler = data => {
        buffer = Buffer.concat([buffer, data]);
        const text = buffer.toString('utf8');
        if (text.includes('NAK') || text.includes('NACK') || text.includes('ERROR')) {
          cleanup(false, 'Receiver rejected command!', true);
          return;
        }
        if (expectAck && text.includes('ACK')) {
          cleanup(true, 'Receiver acknowledged (ACK)');
          return;
        }
        if (text.includes('INPROGRESS')) {
          setCommandTimeout();
        }
        if (expectAck && buffer.length > 2048) {
          cleanup(false, 'No valid response (buffer overflow)', true);
        }
      };

      const errorHandler = err => {
        cleanup(false, `Connection error: ${err.message}`, true);
      };

      const setCommandTimeout = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          cleanup(!expectAck, expectAck ? 'No response received' : 'Command sent (no ACK expected)');
        }, expectAck ? timeout : CONFIG.timeouts.nonAckPacket);
      };

      setCommandTimeout();
      socket.on('data', handler);
      socket.on('error', errorHandler);

      try {
        socket.write(packet, err => {
          if (err) cleanup(false, `Send failed: ${err.message}`, true);
        });
      } catch (err) {
        cleanup(false, `Send error: ${err.message}`, true);
      }
    });
  };
};

function buildJsonCommandHex(commandutf8, payloadJsonString) {
  const commandHex = Buffer.from(commandutf8, 'utf8').toString('hex');
  const payloadHex = Buffer.from(payloadJsonString, 'utf8').toString('hex');
  const payloadBytesLength = payloadHex.length / 2;
  const payloadStringLength = payloadJsonString.length;
  const commandBytesLength = commandHex.length / 2;
  const headerStructureBytesCount = 1 + 2 + 2 + commandBytesLength + 1 + 2;
  const totalLengthForFieldLL = headerStructureBytesCount + payloadBytesLength + CHECKSUM_LENGTH;
  const headerBuffer = Buffer.alloc(headerStructureBytesCount);
  let offset = 0;
  headerBuffer.writeUInt8(0x54, offset); offset += 1;
  headerBuffer.writeUInt16BE(totalLengthForFieldLL, offset); offset += 2;
  headerBuffer.writeUInt16BE(0x0000, offset); offset += 2;
  Buffer.from(commandHex, 'hex').copy(headerBuffer, offset); offset += commandBytesLength;
  headerBuffer.writeUInt8(0x00, offset); offset += 1;
  if (payloadStringLength > 0xFFFF) {
    throw new Error(`SET_SETDAT JSON payload too long (${payloadStringLength} chars), exceeds 65535 limit for 2-byte length field.`);
  }
  headerBuffer.writeUInt16BE(payloadStringLength, offset); offset += 2;
  const fullHexStringWithoutChecksum = headerBuffer.toString('hex') + payloadHex;
  const finalPacketBuffer = addCheckSum(fullHexStringWithoutChecksum);
  return finalPacketBuffer.toString('hex');
}

function mapChannelIdForSetDat(id) {
  switch (id) {
    case 'SWMIX1': return 'SW1';
    case 'SWMIX2': return 'SW2';
    case 'SWMIX3': return 'SW3';
    case 'SWMIX4': return 'SW4';
    default: return id;
  }
}

/* ────────────────────────────────────────────── AVR COMMUNICATION ────────────────────────────────────────────── */
async function getAvrInfoAndStatus(socket) {
  const sendRawAndParseJson = (hexWithChecksum, label) =>
    new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const packet = Buffer.from(hexWithChecksum, 'hex');
      let timer;
      const cleanup = () => { socket.off('data', onData); socket.off('error', onError); clearTimeout(timer); };
      const onData = data => {
        buffer = Buffer.concat([buffer, data]);
        const utf8 = buffer.toString('utf8');
        const jsonStart = utf8.indexOf('{');
        const jsonEnd = utf8.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
          try {
            const potentialJson = utf8.slice(jsonStart, jsonEnd + 1);
            const parsed = JSON.parse(potentialJson);
            cleanup();
            resolve(parsed);
          } catch (err) {
            // Wait for more data
          }
        } else if (buffer.length > 8192) {
          cleanup();
          reject(new Error(`${label} response buffer overflow`));
        }
      };
      const onError = err => { cleanup(); reject(new Error(`Socket error during ${label}: ${err.message}`)); };
      timer = setTimeout(() => { cleanup(); reject(new Error(`${label} timed out waiting for JSON response.`)); }, CONFIG.timeouts.command);
      socket.on('data', onData);
      socket.on('error', onError);
      socket.write(packet, err => {
        if (err) { cleanup(); reject(new Error(`Write error during ${label}: ${err.message}`)); }
        else { console.log('...'); }
      });
    });

  const infoJson = await sendRawAndParseJson('54001300004745545f415652494e460000006c', 'GET_AVRINF');
  const statusJson = await sendRawAndParseJson('54001300004745545f41565253545300000089', 'GET_AVRSTS');

  //console.log(`AVR reports DType: ${infoJson?.DType}`);

  const reportedDType = infoJson?.DType ?? null;
  let activeChannels = [];
  let rawChSetup = [];
  if (statusJson?.ChSetup && Array.isArray(statusJson.ChSetup)) {
    rawChSetup = statusJson.ChSetup;
    activeChannels = statusJson.ChSetup
      .filter(entry => Object.values(entry)[0] !== 'N')
      .map(entry => Object.keys(entry)[0]);
  } else {
    throw new Error("ChSetup is missing or invalid in AVR status response. Cannot construct SET_SETDAT.");
  }
  console.log(`Detected Active Channels: ${activeChannels.join(', ')}`);
  return {
    activeChannels,
    dataType: infoJson?.DType,
    coefWaitTime: infoJson?.CoefWaitTime,
    avrStatus: statusJson,
    rawChSetup
  };
}

function generatePackets(coeffsHex, channelConfig, tc, sr, channelByte) {
  const packets = [];
  let currentIndex = 0;
  const totalFloatsToSend = coeffsHex.length;

  // Warning for float count mismatch (keep this)
  if (totalFloatsToSend !== channelConfig.totalFloats) {
    console.warn(`Mismatch: Expected ${channelConfig.totalFloats} floats, found ${totalFloatsToSend}. Proceeding with actual count.`);
  }

  for (let packetIndex = 0; packetIndex < channelConfig.packetCount; packetIndex++) {
    const isFirstPacket = packetIndex === 0;
    const isLastPacket = packetIndex === channelConfig.packetCount - 1;

    // Determine the actual number of floats in this packet's payload (keep this)
    let numFloatsInPacket;
    if (isFirstPacket) {
      numFloatsInPacket = Math.min(channelConfig.firstPacketFloats, totalFloatsToSend - currentIndex);
    } else if (isLastPacket) {
      numFloatsInPacket = totalFloatsToSend - currentIndex;
    } else {
      numFloatsInPacket = Math.min(channelConfig.midPacketFloats, totalFloatsToSend - currentIndex);
    }
    if (numFloatsInPacket <= 0) break; // Safety break

    // --- START CHANGE 1: Correct Size Field Calculation ---
    let sizeFieldBytes;
    if (isFirstPacket) {
        // Use fixed 512 size for the field in the FIRST packet's header
        sizeFieldBytes = FULL_PACKET_PAYLOAD_BYTES; // 512
    } else {
        // Use actual payload size for all OTHER packets
        sizeFieldBytes = numFloatsInPacket * BYTES_PER_FLOAT;
    }
    const sizeFieldHex = sizeFieldBytes.toString(16).padStart(4, '0');
    // --- END CHANGE 1 ---

    // --- START CHANGE 2: Correct ACK Expectation Logic ---
    // Determine if the packet requires ACK
    // ACK needed if NOT last packet OR if it IS the last packet AND contains the standard mid-packet float count
    const expectAck = !isLastPacket || (isLastPacket && numFloatsInPacket === channelConfig.midPacketFloats);
    // --- END CHANGE 2 ---


    const packetNumHex = packetIndex.toString(16).padStart(2, '0'); // Packet sequence number
    let headerBase = CMD_SET_COEFDT_HEX + "00" + sizeFieldHex; // Build header base with corrected size field

    // Add Info Bytes only for the first packet (keep this)
    if (isFirstPacket) {
      // Ensure correct order: tc + sr + chan + pad
      const headerInfo = tc + sr + channelByte.toString(16).padStart(2, '0') + '00';
      headerBase += headerInfo;
    }

    // Get the payload coefficients (keep this)
    const payloadCoeffs = coeffsHex.slice(currentIndex, currentIndex + numFloatsInPacket);
    const payloadHex = payloadCoeffs.join('');

    // Calculate lengths for Total Length field (keep this)
    const headerBaseBytesLength = headerBase.length / 2;
    const payloadBytesLength = payloadHex.length / 2; // Use actual payload length
    // Total Length field value calculation (keep this)
    const totalPacketLength = 1 + 2 + 1 + 1 + headerBaseBytesLength + payloadBytesLength + CHECKSUM_LENGTH;
    const packetLengthHex = totalPacketLength.toString(16).padStart(4, '0');

    // Construct the packet string before checksum (keep this)
    const packetHexWithoutChecksum = '54' + packetLengthHex + packetNumHex + channelConfig.fullPacketCountField + headerBase + payloadHex;

    // --- Add Optional Length Logging Here If Needed ---
    // console.log(`DEBUG: Packet ${packetIndex} String length before checksum: ${packetHexWithoutChecksum.length}`);
    // ---

    // Add checksum (keep this)
    const finalPacketBuffer = addCheckSum(packetHexWithoutChecksum);

    // Push packet using the corrected 'expectAck' logic (Part of CHANGE 2 applied here)
    packets.push({ hexData: finalPacketBuffer.toString('hex'), expectAck: expectAck });

    // Increment index (keep this)
    currentIndex += numFloatsInPacket;
    if (currentIndex >= totalFloatsToSend) break; // Exit loop if done
  } // End of loop

  return packets; // Return generated packets
}

/* ────────────────────────────────────────────── MAIN EXECUTION FLOW ────────────────────────────────────────────── */
(async () => {
  let client = null; // Assuming this is used for AVR control later?
  try {
    // --- 1. Read Target IP from Command Line Argument ---
    if (process.argv.length < 3) {
        throw new Error("Missing target IP address argument. Call like: node sendFilters.js <TARGET_IP>");
    }
    const targetIp = process.argv[2];
    console.log(`Target AVR IP received via argument: ${targetIp}`);

    // Basic IP validation
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(targetIp)) {
         throw new Error(`Invalid Target IP address format received: ${targetIp}`);
    }

    // Store the IP in your CONFIG object for the rest of the script to use
    CONFIG.target.ip = targetIp;

    // --- 2. Skip Network Discovery ---
    // await findNetworkDevices(); // REMOVE OR COMMENT OUT THIS CALL

    // Check if IP is now set (it should be from the argument)
    if (!CONFIG.target.ip) {
        // This should technically not happen if argument parsing is correct
        throw new Error("Internal error: Target IP was not set.");
    }

    // --- 3. Call Your File Selection Logic ---
    // This will prompt the user and set CONFIG.files.filters
    await main(); // Assuming main() calls selectOcaFile() and sets CONFIG.files.filters

    // --- 4. Proceed with Existing Logic ---
    // Check if file path was successfully set by main()
    if (!CONFIG.files.filters || !fs.existsSync(CONFIG.files.filters)) {
        throw new Error(`Filter file path was not selected or file does not exist: ${CONFIG.files.filters}`);
    }

    // Now safe to read the selected file
    console.log(`Reading selected filter file: ${CONFIG.files.filters}`);
    const filterData = JSON.parse(fs.readFileSync(CONFIG.files.filters, 'utf8'));
    // console.log('Calibration data below successfully loaded and will be transferred:', filterData); // Optional detailed log

    // Validate filterData structure (your existing checks)
    let multEqType;
    if (typeof filterData.eqType === 'undefined') {
        throw new Error(`Invalid format in ${CONFIG.files.filters}. Expected 'eqType'.`);
    }
    switch (filterData.eqType) {
      case 0: multEqType = "MultEQ"; break;
      case 1: multEqType = "XT"; break;
      case 2: multEqType = "XT32"; break;
      default: throw new Error(`Unsupported eqType in filter file: ${filterData.eqType}`);
    }
    if (!filterData?.channels?.length) {
      throw new Error(`Invalid format in ${CONFIG.files.filters}. Expected 'channels' array.`);
    }

    //console.log(`Connecting to AVR at ${CONFIG.target.ip}:${CONFIG.target.port}`);
    console.log(`Connecting to AVR at ${CONFIG.target.ip}`);
    
    // Optional: wait a bit before Telnet (if AVR needs it)
    await new Promise(resolve => setTimeout(resolve, 5000));

    // ⬇️ Now actually wait for Telnet commands to complete before continuing
    await sendTelnetCommands(CONFIG.target.ip, 23, filterData.lpfForLFE);

    //console.log("Telnet setup complete. Proceeding with filter transfer...");

    client = await connectToAVR(CONFIG.target.ip, CONFIG.target.port, CONFIG.timeouts.connect);
    console.log("Connection secured.");

    const send = createCommandSender(client);
    console.log("Getting AVR information and status...");
    const {activeChannels, dataType, coefWaitTime, avrStatus, rawChSetup} = await getAvrInfoAndStatus(client);
    
    console.log("Comparing .oca file channels and configuration with AVR reports...");

    if (!filterData || !filterData.channels || !Array.isArray(filterData.channels)) {
        throw new Error(`Invalid or missing 'channels' array in ${CONFIG.files.filters}.`);
    }
    if (!activeChannels || !Array.isArray(activeChannels)) {
        throw new Error(`Could not retrieve valid active channel list from AVR.`);
    }

    if (!avrStatus || !avrStatus.AssignBin) { // Ensure AssignBin from AVR is available
      throw new Error(`Could not retrieve valid AssignBin status from AVR.`);
    }

    const ocaChannelNames = filterData.channels.map(ch => ch.commandId);
    const normalizedOcaChannelNames = new Set(ocaChannelNames.map(id => mapChannelIdForSetDat(id)));
    const normalizedAvrChannelNames = new Set(activeChannels.map(id => mapChannelIdForSetDat(id)));
    const missingOnAvr = [];
    for (const ocaChannel of normalizedOcaChannelNames) {
     if (!normalizedAvrChannelNames.has(ocaChannel)) {
       const originalOcaName = ocaChannelNames.find(name => mapChannelIdForSetDat(name) === ocaChannel);
       missingOnAvr.push(originalOcaName || ocaChannel);
     }
    }
     // --- Mismatch Handling: Throw Error, Instruct User ---
    if (missingOnAvr.length > 0) {
     console.error(`\n--- Configuration Mismatch ---`);
     console.error(`The following channels expected by '${CONFIG.files.filters}' are NOT active/configured on the AVR:`);
     console.error(`[${missingOnAvr.join(', ')}]`);
     console.error(`\nAVR reports active channels: [${activeChannels.join(', ')}]`);
     console.error(`\nPlease manually correct the AVR speaker configuration using its own menu to match the expected setup, then re-run this program!`);
     throw new Error("Configuration mismatch requires manual correction on the AVR."); // Stop execution
    }

    // --- 2. Compare AssignBin (Warning Only) ---
    // Check if AssignBin exists in the .oca file for comparison
    if (filterData.ampAssignBin && typeof filterData.ampAssignBin === 'string') {
        const ocaAssignBin = filterData.ampAssignBin;
        const avrAssignBin = avrStatus.AssignBin;

        if (ocaAssignBin.trim() !== avrAssignBin.trim()) { // Compare trimmed strings
            console.warn(`\n⚠️ Warning: Configuration Mismatch (Amplifier Assignment)`);
            console.warn(`   The amplifier assignment map ('AssignBin') in the .oca file does not match the AVR's current setting.`);
            // Optional: Display the differing strings for advanced users, but can be very noisy.
            // console.warn(`   .oca AssignBin: ${ocaAssignBin}`);
            // console.warn(`   AVR AssignBin : ${avrAssignBin}`);
            console.warn(`   This indicates the AVR's amp assignments (e.g., Zone 2, Bi-Amp, Speaker Enables) may have changed since the .oca file was created.`);
            console.warn(`   Proceeding using the AVR's *current* amplifier assignment. If speakers are missing or behave unexpectedly, check the AVR's setup menu.\n`);
        } else {
             console.log("   Amplifier assignment map ('AssignBin') matches between .oca file and AVR."); // Confirmation if they match
        }
    } else {
         console.log("   Skipping amplifier assignment map comparison ('AssignBin' not found in .oca file).");
    }

    // --- If validation passes, check for extra channels (Warning only) ---
     const missingInOca = [];
     for (const avrChannel of normalizedAvrChannelNames) {
       if (!normalizedOcaChannelNames.has(avrChannel)) {
           const originalAvrName = activeChannels.find(name => mapChannelIdForSetDat(name) === avrChannel);
           missingInOca.push(originalAvrName || avrChannel);
       }
     }
     if (missingInOca.length > 0) {
      console.warn(`\n⚠️ Warning: The AVR reports active channels that are NOT present in '${CONFIG.files.filters}': [${missingInOca.join(', ')}]. Settings for these channels will NOT be updated.\n`);
     }
    //console.log("✅ Channel validation successful. .oca file is compatible with the current AVR setup.");
  
    const converterFunc = dataType?.toLowerCase() === 'float' ? floatToHex : floatToFixed32HexLE;

    const enterAudCommandHex = '5400130000454e5445525f41554459000000';
    let audEntered = false;

    while (!audEntered) {
      try {
        const ackPromise = new Promise((resolve, reject) => {
          const onData = (data) => {
            const response = data.toString('utf8');
            if (response.includes('ACK')) {
              audEntered = true;
              client.removeListener('data', onData);
              resolve();
            } else if (response.includes('INPROGRESS')) {
              // Still waiting, no immediate action needed
            }
          };

          client.on('data', onData);
          setTimeout(() => {
            client.removeListener('data', onData);
            reject(new Error('ACK timeout'));
          }, 3000);
        });

        await send(enterAudCommandHex, 'ENTER_AUDY', { timeout: 3000, expectAck: false });
        await ackPromise;

      } catch (e) {
        if (!audEntered) {
          console.log('Retrying to set the AVR in correct mode...');
          await delay(1000);
        }
      }
    }

    console.log('AVR ready to accept filters.');
    await sendSetDatCommand(send, avrStatus, rawChSetup, filterData);
    if (dataType?.toLowerCase() === 'fixeda') {
      const initDelay = coefWaitTime?.Init ?? 250;
      await delay(initDelay);
      await send('5400130000494e49545f434f454653000000', 'INIT_COEFS', { timeout: CONFIG.timeouts.finalize });
      const postInitDelay = coefWaitTime?.Final ?? 250;
      await delay(postInitDelay);
    }

    if (!activeChannels.length) {
      console.warn("No active channels reported by AVR. Skipping coefficient sending.");
    } else {
      await processChannels(activeChannels, filterData, multEqType, filterData.hasGriffinLiteDSP, converterFunc, dataType, send);
    }

    console.log("Finalizing filter transfer...");
    await finalizeTransfer(dataType, send);
    console.log("\nTransfer completed successfully!");

    console.log(`Your receiver is now ready to be used with A1 Evo optimal settings.`);
    console.log(`\nAudyssey 'Reference' and 'Flat' modes are loaded with different A1 Evo filters.`);
    console.log(`Use 'Flat' mode for regular volume levels and 'Reference' mode for low volumes.`);
    console.log(`Both modes are calibrated to be used with Dynamic EQ OFF!`);

  } catch (err) {

    console.error('\n--- EXECUTION FAILED !!! ---');
    console.error("Error:", err.message);
  
  } finally {
    // --- 1. Close the Client Connection (Keep this) ---
    if (client && !client.destroyed) { // Check if not already destroyed
      console.log("Closing AVR connection...");
      try {
          // Use end() for graceful shutdown, destroy() is more forceful
          client.end(() => {
              // console.log("Connection gracefully closed via end().");
              // Optionally call destroy after end completes if needed, but usually not
              // client.destroy();
          });
          // Give it a moment to close gracefully before potentially forcing it
           setTimeout(() => {
               if (client && !client.destroyed) {
                  console.warn("Connection did not close gracefully, forcing destroy.");
                  client.destroy();
               }
           }, 500); // Wait 500ms before force-destroying

      } catch (closeErr) {
          console.error("Error closing connection:", closeErr.message);
          // Force destroy if ending failed
           if (client && !client.destroyed) {
              client.destroy();
           }
      }
    } else {
         // console.log("Client connection already closed or not established.");
    }

    // --- 2. Remove User Interaction (Press any key) ---
    // console.log("\nPress any key to exit..."); // REMOVE THIS LINE
    // // Remove all the stdin handling logic below
    // if (process.stdin.isTTY) {
    //     try {
    //          process.stdin.setRawMode(true);
    //     } catch (rawModeErr) {
    //          console.error("Could not set raw mode on stdin:", rawModeErr.message);
    //     }
    //     process.stdin.resume();
    //     process.stdin.once('data', () => process.exit(0)); // REMOVE THIS
    // } else {
    //     console.log("(Non-interactive session detected, exiting automatically in 3s)");
    //     setTimeout(() => process.exit(0), 3000); // REMOVE THIS
    // }

    // --- 3. Let the script exit via process.exit() in try/catch ---
    // The script will naturally reach the end here. The actual exit
    // with the correct code (0 or 1) should happen within the main
    // try block (after successful completion) or the catch block (on error).
    console.log("[sendFilters.js] Reached end of finally block.");

  } // End of finally block

})(); // End of IIFE
async function findNetworkDevices() {
  console.log(`Searching for a Denon/Marantz AV receiver in your network...`);
  const discovery = new UPNPDiscovery();
  let devices = [];
  
  try {
    devices = await discovery.discover();
  } catch (error) {
    console.error('Discovery Error:', error);
  }
  
  let selectedDevice = null;
  
  // Check if devices were actually found
  if (devices && devices.length > 0) {
    try {
      // Let the selection function handle showing devices and getting user input
      selectedDevice = await UPNPDiscovery.interactiveDeviceSelection(devices);
      
      // Check if a device was actually selected
      if (selectedDevice && selectedDevice.address) {
        CONFIG.target.ip = selectedDevice.address;
      } else {
        console.log('No device selected from the list. Proceeding to manual IP entry.');
      }
    } catch (err) {
      console.error('Selection error:', err);
    }
  } else {
    console.log('No UPnP devices were found in your network.');
  }
  
  // If no device was found or selected, prompt for manual entry
  if (!CONFIG.target.ip) {
    console.log('Please enter an IP address manually.');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    CONFIG.target.ip = await new Promise(resolve => {
      rl.question("Enter the AVR IP address manually: ", answer => {
        rl.close();
        
        // If user just presses Enter without typing anything
        if (!answer.trim()) {
          console.log('No IP address entered. Exiting...');
          process.exit(1);
        }
        
        resolve(answer.trim());
      });
    });
  }
  
  console.log(`Target AVR set to ${CONFIG.target.ip}`);
}

async function connectToAVR(ip, port, timeout) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ port, host: ip, timeout });
    const connectionTimeout = setTimeout(() => reject(new Error(`Connection timed out after ${timeout}ms.`)), timeout);
    client.once('connect', () => {
      clearTimeout(connectionTimeout);
      client.removeAllListeners('error');
      client.removeAllListeners('timeout');
      resolve(client);
    });
    client.once('error', err => {
      clearTimeout(connectionTimeout);
      reject(new Error(`Connection error: ${err.message}`));
    });
    client.once('timeout', () => {
      clearTimeout(connectionTimeout);
      reject(new Error('Connection timed out.'));
    });
  });
}

async function sendSetDatCommand(send, avrStatus, rawChSetup, filterData) {
    const JSON_PAYLOAD_THRESHOLD = 488; // Keep the threshold

    // --- Always use live data from AVR ---
    if (!avrStatus?.AmpAssign || !avrStatus?.AssignBin || !rawChSetup) {
        throw new Error("Cannot send SET_SETDAT: Required fields missing from AVR status.");
    }
    const sourceAmpAssign = avrStatus.AmpAssign;
    const sourceAssignBin = avrStatus.AssignBin;

    // Derive SpConfig from live rawChSetup based on active channels
    const activeChannelIds = rawChSetup
        .filter(entry => Object.values(entry)[0] !== 'N')
        .map(entry => Object.keys(entry)[0]);

    const finalSpConfig = activeChannelIds.map(channelId => {
        const mappedId = mapChannelIdForSetDat(channelId);
        const setupEntry = rawChSetup.find(entry => Object.keys(entry)[0] === channelId);
        const speakerType = setupEntry ? setupEntry[channelId] : 'S'; // Default to 'S' if somehow missing
        if (!setupEntry) console.warn(`WARN: Could not find raw setup entry for active channel ${channelId}`);
        // Ensure we don't add 'N' (Not Used) channels to SpConfig
        return speakerType !== 'N' ? { [mappedId]: speakerType } : null;
    }).filter(Boolean); // Filter out null entries for 'N' channels

    // --- Gather Distance, ChLevel, Crossover based ONLY on active AVR channels ---
    const definedChannelIds = new Set(activeChannelIds.map(id => mapChannelIdForSetDat(id)));
    const distanceArray = [];
    const chLevelArray = [];
    const crossoverArray = [];

    for (const ocaChannel of filterData.channels) {
        const mappedOcaChannelId = mapChannelIdForSetDat(ocaChannel.commandId);

        // Only process data if this channel is ACTIVE on the AVR
        if (definedChannelIds.has(mappedOcaChannelId)) {
            // Distance (remains the same)
            if (ocaChannel.distanceInMeters !== undefined) {
                const distanceInCm = Math.round(ocaChannel.distanceInMeters * 100);
                distanceArray.push({ [mappedOcaChannelId]: distanceInCm });
            }
            // Channel Level (remains the same)
            if (ocaChannel.trimAdjustmentInDbs !== undefined) {
                const trimLevel = Math.round(ocaChannel.trimAdjustmentInDbs * 10);
                chLevelArray.push({ [mappedOcaChannelId]: trimLevel });
            }

            // --- Revised Crossover Logic ---
            // Check if it's a subwoofer FIRST
            if (mappedOcaChannelId.startsWith('SW')) {
                // Always add 'F' for active subwoofers, regardless of whether 'xover' exists in .oca
                crossoverArray.push({ [mappedOcaChannelId]: "F" });
            }
            // ELSE, if it's a speaker AND the xover field exists...
            else if (ocaChannel.xover !== undefined) {
                const numericXover = Number(ocaChannel.xover);
                let xoverValue;

                if (!isNaN(numericXover) && numericXover >= 40) { // Basic validation
                    if (numericXover >= 100) {
                        xoverValue = numericXover / 10;
                    } else {
                        xoverValue = numericXover;
                    }
                     // Add speaker crossover to the array
                    crossoverArray.push({ [mappedOcaChannelId]: xoverValue });
                } else {
                    console.warn(`WARN: Invalid or out-of-range numeric crossover value (${ocaChannel.xover}) for speaker ${mappedOcaChannelId} in .oca file. Skipping crossover.`);
                    // No 'continue' needed here, just don't push if invalid
                }
            }
            // Note: If it's a speaker and 'xover' is undefined in .oca, nothing is added for crossover, which is correct.
            // --- End Revised Crossover Logic ---
        }
    } // End of loop through ocaChannel

    // --- Payload assembly and splitting logic (using sourceAmpAssign, sourceAssignBin, finalSpConfig) ---
    const basePayloadPart1 = {
        AmpAssign: sourceAmpAssign,
        AssignBin: sourceAssignBin,
        SpConfig: finalSpConfig
    };
    if (distanceArray.length > 0) { // Add Distance if present
        basePayloadPart1.Distance = distanceArray;
    }

    const payloadPart2Base = {
        AudyFinFlg: "NotFin",
        AudyDynEq: 0,
        AudyEqRef: 0,
        AudyDynVol: 0,
        AudyDynSet: "M",
        AudyMultEq: 1,
        AudyEqSet: "Flat",
        AudyLfc: 0,
        AudyLfcLev: 4
    };
     if (crossoverArray.length > 0) {
        payloadPart2Base.Crossover = crossoverArray; // Add Crossover if present
    }

    // Check size and decide if split is needed (based on combined size of Config, Distance, Level)
    const potentialPayload1 = { ...basePayloadPart1 };
     if (chLevelArray.length > 0) { // Add Level if present
        potentialPayload1.ChLevel = chLevelArray;
    }
    const potentialPayload1JsonString = JSON.stringify(potentialPayload1);
    const requiresSplit = potentialPayload1JsonString.length > JSON_PAYLOAD_THRESHOLD;

    let finalPayload1, finalPayload2;
     if (requiresSplit) {
        //console.log(`Payload size (${potentialPayload1JsonString.length} chars) exceeds threshold (${JSON_PAYLOAD_THRESHOLD}). Splitting SET_SETDAT.`);
        // Packet 1: Config + Distance only
        finalPayload1 = { ...basePayloadPart1 }; // basePayloadPart1 already includes Distance if available

        // Packet 2: ChLevel + Crossover + Audy settings
        finalPayload2 = { ...payloadPart2Base };
        if (chLevelArray.length > 0) {
            finalPayload2.ChLevel = chLevelArray; // Add Level here
        }
    } else {
        //console.log(`Payload size (${potentialPayload1JsonString.length} chars) within threshold (${JSON_PAYLOAD_THRESHOLD}). Sending combined SET_SETDAT part 1.`);
        // Packet 1: Config + Distance + ChLevel
        finalPayload1 = potentialPayload1; // potentialPayload1 includes Config, Distance (if present), Level (if present)

        // Packet 2: Crossover + Audy settings only
        finalPayload2 = payloadPart2Base; // Does NOT include Level
    }

    // Send Packet 1
    const setDataJsonString1 = JSON.stringify(finalPayload1);
    const setDataCommandHex1 = buildJsonCommandHex('SET_SETDAT', setDataJsonString1);
    await send(setDataCommandHex1, 'SET_SETDAT_P1', { addChecksum: false });
    await delay(250);

    // Send Packet 2
    const setDataJsonString2 = JSON.stringify(finalPayload2);
    const setDataCommandHex2 = buildJsonCommandHex('SET_SETDAT', setDataJsonString2);
    await send(setDataCommandHex2, 'SET_SETDAT_P2', { addChecksum: false });
    await delay(250);
}

async function processChannels(activeChannels, filterData, multEqType, hasGriffinLiteDSP, converterFunc, dataType, send) {
  for (const originalChannelId of activeChannels) {
    const lookupChannelId = mapChannelIdForSetDat(originalChannelId);
    console.log(`--- Processing Channel: ${originalChannelId}`);
    const channelFilterData = filterData.channels.find(ch => ch.commandId === lookupChannelId);
    if (!channelFilterData?.filter?.length || !channelFilterData?.filterLV?.length) {
      console.warn(`Missing filter data for ${lookupChannelId}. Skipping.`);
      continue;
    }
    const processedData = processFilterData(channelFilterData, multEqType, lookupChannelId);
    for (const tc of CONFIG.targetCurves) {
      await sendTargetCurve(tc, processedData, originalChannelId, multEqType, filterData.hasGriffinLiteDSP, converterFunc, dataType, send);
      await delay(250)
    }
    console.log(`--- Channel processed!`);
  }
}

function processFilterData(channelFilterData, multEqType, lookupChannelId) {
  const isSub = lookupChannelId.startsWith('SW') || lookupChannelId === 'LFE';
  const configKey = isSub ? 'sub' : 'speaker';
  let filterData = { ...channelFilterData };
  if (multEqType !== 'XT32' && EXPECTED_NON_XT32_FLOAT_COUNTS[multEqType]) {
    const expectedCount = EXPECTED_NON_XT32_FLOAT_COUNTS[multEqType][configKey];
    if (filterData.filter.length === expectedCount + 1) {
      console.log(`Trimming extra float from 'filter' array for ${lookupChannelId}`);
      filterData.filter = [...filterData.filter];
      filterData.filter.pop();
    }
  }
  filterData.filter = convertXT32(filterData.filter);
  filterData.filterLV = convertXT32(filterData.filterLV);
  return filterData;
}

async function sendTargetCurve(tc, processedData, originalChannelId, multEqType, hasGriffinLiteDSP, converterFunc, dataType, send) {
  let coeffs, curveName;
  if (tc === '01') {
    coeffs = processedData.filter;
    curveName = 'Reference (TC01)';
  } else if (tc === '00') {
    coeffs = processedData.filterLV;
    curveName = 'Flat (TC00)';
  } else {
    console.warn(`   Unsupported target curve '${tc}'. Skipping.`);
    return;
  }
  if (!coeffs?.length) {
    console.warn(`   Skipping ${curveName} due to zero or invalid floats.`);
    return;
  }

  // Build config and get channel byte
  let channelConfig, channelByte;
  try {
    channelConfig = buildPacketConfig(coeffs.length);
    channelByte = getChannelTypeByte(originalChannelId, multEqType, hasGriffinLiteDSP);
  } catch (err) {
    console.error(`   Error configuring ${originalChannelId}/${curveName}: ${err.message}. Skipping.`);
    return;
  }

  // Generate hex coefficients
  const coeffsHex = coeffs.map(converterFunc);

  // Send for each sample rate
  for (const sr of CONFIG.sampleRates) {
    const packets = generatePackets(coeffsHex, channelConfig, tc, sr, channelByte);
    
    for (let i = 0; i < packets.length; i++) {
      const { hexData, expectAck } = packets[i];
      const packetLabel = `PACKET ${i}/${packets.length - 1} ${originalChannelId} ${curveName} SR${sr}`;
      
      try {
        await send(hexData, packetLabel, { expectAck, addChecksum: false });
      } catch (err) {
        console.error(`!!! FAILED sending ${packetLabel}: ${err.message}`);
        throw err;
      }
    }
    
    // ── Added termination command for full-length last packet ──
    const lastPacket = packets[packets.length - 1];
    if (lastPacket.expectAck) {
      let terminationHex;
      if (dataType?.toLowerCase() === 'fixeda') {
        terminationHex = '54001701015345545f434f454644540000040b07f2ff';
      } else {
        terminationHex = '54001708085345545f434f4546445400000400000000';
      }
      try {
        await send(terminationHex, 'SET_COEFDT_TERMINATION', {expectAck: true});
      } catch (err) {
        console.error(`!!! FAILED sending termination command for ${originalChannelId} ${curveName}: ${err.message}`);
        throw err;
      }
    }

  }
}

async function finalizeTransfer(dataType, send) {
  if (dataType?.toLowerCase() === 'fixeda') {
    //console.log("Using 'FixedA' finalization sequence (AudyFinFlg)...");
    await delay(10000);
    //console.log("AudyFinFlg acknowledged.");
  } else {
    //console.log("Using standard finalization sequence (FINZ)...");
    //console.log("Sending FINZ command...");
    await send('540013000046494e5a5f434f454653000000', 'FINZ', { timeout: CONFIG.timeouts.finalize });
    //console.log("FINZ acknowledged.");
  }
  const finalFlagPayload = { "AudyFinFlg": "Fin" };
  const finalFlagJsonString = JSON.stringify(finalFlagPayload);
  const finalFlagCommandHex = buildJsonCommandHex('SET_SETDAT', finalFlagJsonString);
  //console.log("Sending AudyFinFlg command...");
  await send(finalFlagCommandHex, 'SET_AUDYFINFLG', { addChecksum: false });
  //console.log("Exiting Audyssey mode...");
  await send('5400130000455849545f4155444d44000000', 'EXIT_AUDMD');
  //console.log("Exit Audyssey mode acknowledged.");
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
