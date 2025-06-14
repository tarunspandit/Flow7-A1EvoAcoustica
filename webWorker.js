/**
 * @file webWorker.js
 * @description Audio frequency response analysis worker.
 * This worker performs intensive calculations to find the optimal crossover filter
 * settings (High-Pass and Low-Pass) for a subwoofer. It compares the subwoofer's
 * frequency response against a target curve, applying various digital filters
 * and calculating the Mean Absolute Error (MAE) to find the best fit.
 * This is used in audio applications like speaker/subwoofer integration and room correction.
 */

// --- Constants for Clarity and Safety ---

const MIN_DB_LEVEL = -200; // Minimum decibel level to prevent log(0) errors.
const MIN_MAGNITUDE_THRESHOLD = 1e-10; // Magnitudes below this are treated as silence.

// Define constants for filter types to prevent typos and improve readability.
const FILTER_TYPE = {
  LINKWITZ_RILEY: 'L-R',
  BUTTERWORTH: 'BU',
  LOW_PASS: 'LP',
  HIGH_PASS: 'HP',
};

// Define constants for message types handled by the worker.
const MESSAGE_TYPE = {
  INIT: 'init',
  TASK_BATCH: 'taskBatch',
  BATCH_RESULT: 'batchResult',
};

// --- Worker State (Initialized via 'init' message) ---
let state = {
  analysisFrequencies: null,
  subMagnitude: null,
  targetMagnitude: null,
  pointsPerOctave: 0,
  analysisStartFreq: 0,
  lowPassCutoffCandidates: [],
  highPassCutoffCandidates: [],
  // Pre-defined filter configurations to test.
  highPassFilterConfigs: [
    { type: FILTER_TYPE.LINKWITZ_RILEY, slope: 24 },
    { type: FILTER_TYPE.LINKWITZ_RILEY, slope: 36 },
    { type: FILTER_TYPE.LINKWITZ_RILEY, slope: 48 },
    { type: FILTER_TYPE.BUTTERWORTH, slope: 12 },
    { type: FILTER_TYPE.BUTTERWORTH, slope: 18 },
    { type: FILTER_TYPE.BUTTERWORTH, slope: 24 },
    { type: FILTER_TYPE.BUTTERWORTH, slope: 36 },
    { type: FILTER_TYPE.BUTTERWORTH, slope: 48 },
  ],
  lowPassFilterConfig: { type: FILTER_TYPE.LINKWITZ_RILEY, slope: 24 },
  filterMagnitudeCache: new Map(),
};


// --- Core Calculation Functions ---

/**
 * Converts a frequency in Hz to an index in the analysis data array.
 * @param {number} freq - The frequency in Hz.
 * @param {number} startFreq - The starting frequency of the analysis scale.
 * @param {number} pointsPerOctave - The resolution of the analysis.
 * @param {number} totalPoints - The total number of points in the data array.
 * @returns {number} The calculated array index.
 */
function freqToIndex(freq, startFreq, pointsPerOctave, totalPoints) {
  if (freq < startFreq) return 0;
  const index = pointsPerOctave * Math.log2(freq / startFreq);
  return Math.min(Math.round(index), totalPoints - 1);
}

/**
 * Calculates the gain of a Linkwitz-Riley (L-R) filter at a specific frequency.
 * L-R filters are commonly used in audio crossovers for their flat summed response.
 * @param {number} freq - The frequency to calculate the gain for.
 * @param {number} cutoff - The filter's -6dB cutoff frequency.
 * @param {number} linkwitzRileyOrder - The order of the filter (e.g., 2 for LR2/12dB/oct, 4 for LR4/24dB/oct).
 * @param {string} type - 'LP' (Low-Pass) or 'HP' (High-Pass).
 * @returns {number} The filter gain in decibels (dB).
 */
function getLRFilterGain(freq, cutoff, linkwitzRileyOrder, type) {
  if (freq <= 0 || cutoff <= 0 || linkwitzRileyOrder <= 0) return MIN_DB_LEVEL;
  const ratio = freq / cutoff;
  const ratioPow = Math.pow(ratio, linkwitzRileyOrder);
  let magnitude;
  if (type === FILTER_TYPE.LOW_PASS) {
    magnitude = 1 / (1 + ratioPow);
  } else if (type === FILTER_TYPE.HIGH_PASS) {
    magnitude = ratioPow / (1 + ratioPow);
  } else {
    return MIN_DB_LEVEL; // Should not happen with validated input
  }

  if (magnitude <= MIN_MAGNITUDE_THRESHOLD) return MIN_DB_LEVEL;
  return 20 * Math.log10(magnitude);
}

/**
 * Calculates the gain of a Butterworth filter at a specific frequency.
 * Butterworth filters are known for their maximally flat passband response.
 * @param {number} freq - The frequency to calculate the gain for.
 * @param {number} cutoff - The filter's -3dB cutoff frequency.
 * @param {number} order - The order of the filter.
 * @param {string} type - 'LP' (Low-Pass) or 'HP' (High-Pass).
 * @returns {number} The filter gain in decibels (dB).
 */
function getButterworthFilterGain(freq, cutoff, order, type) {
  if (freq <= 0 || cutoff <= 0 || order <= 0) return MIN_DB_LEVEL;
  const ratio = freq / cutoff;
  let magnitude;
  if (type === FILTER_TYPE.LOW_PASS) {
    magnitude = 1 / Math.sqrt(1 + Math.pow(ratio, 2 * order));
  } else if (type === FILTER_TYPE.HIGH_PASS) {
    magnitude = Math.pow(ratio, order) / Math.sqrt(1 + Math.pow(ratio, 2 * order));
  } else {
    return MIN_DB_LEVEL; // Should not happen with validated input
  }

  if (magnitude <= MIN_MAGNITUDE_THRESHOLD) return MIN_DB_LEVEL;
  return 20 * Math.log10(magnitude);
}

/**
 * Applies High-Pass and Low-Pass filters to a magnitude response.
 * @param {Float32Array} dataMagnitude - The original magnitude response in dB.
 * @param {Float32Array} frequencies - The corresponding frequencies for the data.
 * @param {number} highPassFreq - The high-pass cutoff frequency.
 * @param {object} highPassConfig - The high-pass filter configuration {type, slope}.
 * @param {number} lowPassFreq - The low-pass cutoff frequency.
 * @param {object} lowPassConfig - The low-pass filter configuration {type, slope}.
 * @returns {Float32Array} The new magnitude response with filters applied.
 */
function applyFilters(dataMagnitude, frequencies, highPassFreq, highPassConfig, lowPassFreq, lowPassConfig) {
  const filteredMagnitude = new Float32Array(dataMagnitude.length);
  for (let i = 0; i < dataMagnitude.length; i++) {
    const freq = frequencies[i];
    const originalMag = dataMagnitude[i];

    if (isNaN(originalMag)) {
      filteredMagnitude[i] = NaN;
      continue;
    }

    let highPassGain = MIN_DB_LEVEL;
    // The order of an audio filter is its slope in dB/octave divided by 6.
    if (highPassConfig.type === FILTER_TYPE.LINKWITZ_RILEY) {
      const highPassEffectiveOrder = highPassConfig.slope / 6;
      highPassGain = getLRFilterGain(freq, highPassFreq, highPassEffectiveOrder, FILTER_TYPE.HIGH_PASS);
    } else if (highPassConfig.type === FILTER_TYPE.BUTTERWORTH) {
      const highPassOrder = highPassConfig.slope / 6;
      highPassGain = getButterworthFilterGain(freq, highPassFreq, highPassOrder, FILTER_TYPE.HIGH_PASS);
    }

    let lowPassGain = MIN_DB_LEVEL;
    if (lowPassConfig.type === FILTER_TYPE.LINKWITZ_RILEY) {
      const lowPassEffectiveOrder = lowPassConfig.slope / 6;
      lowPassGain = getLRFilterGain(freq, lowPassFreq, lowPassEffectiveOrder, FILTER_TYPE.LOW_PASS);
    } else if (lowPassConfig.type === FILTER_TYPE.BUTTERWORTH) {
      const lowPassOrder = lowPassConfig.slope / 6;
      lowPassGain = getButterworthFilterGain(freq, lowPassFreq, lowPassOrder, FILTER_TYPE.LOW_PASS);
    }

    // Add gains in dB, which is equivalent to multiplying magnitudes.
    filteredMagnitude[i] = originalMag + highPassGain + lowPassGain;
  }
  return filteredMagnitude;
}

/**
 * Calculates a volume adjustment to best align two responses and finds the resulting error.
 * @param {Float32Array} responseToAdjust - The response to be level-matched (e.g., subwoofer).
 * @param {Float32Array} targetMagnitude - The target response.
 * @param {Float32Array} frequencies - The corresponding frequencies for the data.
 * @param {number} errorRangeStartFreq - The start frequency for the error calculation.
 * @param {number} errorRangeEndFreq - The end frequency for the error calculation.
 * @param {number} pointsPerOctave - The resolution of the analysis.
 * @param {number} analysisStartFreq - The starting frequency of the entire analysis.
 * @returns {{volumeAdjustment: number, meanAbsoluteError: number}} The calculated adjustment and error.
 */
function calculateVolumeAdjustmentAndError(responseToAdjust, targetMagnitude, frequencies, errorRangeStartFreq, errorRangeEndFreq, pointsPerOctave, analysisStartFreq) {
  let sumDiff = 0;
  let count = 0;
  let sumAbsoluteDiff = 0;
  const totalPoints = frequencies.length;

  const startIndex = freqToIndex(errorRangeStartFreq, analysisStartFreq, pointsPerOctave, totalPoints);
  const endIndex = freqToIndex(errorRangeEndFreq, analysisStartFreq, pointsPerOctave, totalPoints);

  // Validate indices before proceeding.
  if (startIndex >= totalPoints || endIndex < 0 || startIndex > endIndex) {
    return { volumeAdjustment: 0, meanAbsoluteError: Infinity };
  }

  // First pass: find the average difference to determine the volume adjustment.
  for (let i = startIndex; i <= endIndex; i++) {
    if (isFinite(responseToAdjust[i]) && isFinite(targetMagnitude[i])) {
      sumDiff += (targetMagnitude[i] - responseToAdjust[i]);
      count++;
    }
  }

  if (count === 0) {
    return { volumeAdjustment: 0, meanAbsoluteError: Infinity };
  }

  const volumeAdjustment = sumDiff / count;

  // Second pass: calculate Mean Absolute Error (MAE) after applying the volume adjustment.
  for (let i = startIndex; i <= endIndex; i++) {
    if (isFinite(responseToAdjust[i]) && isFinite(targetMagnitude[i])) {
      const alignedResponse = responseToAdjust[i] + volumeAdjustment;
      const diff = alignedResponse - targetMagnitude[i];
      sumAbsoluteDiff += Math.abs(diff);
    }
  }

  const meanAbsoluteError = sumAbsoluteDiff / count;
  return { volumeAdjustment, meanAbsoluteError };
}

/**
 * Evaluates a single combination of filter settings.
 * This function encapsulates the logic from the deepest part of the original nested loop.
 * @param {object} taskParams - The parameters for the current evaluation task.
 * @returns {{volumeAdjustment: number, meanAbsoluteError: number, filteredTarget: Float32Array}}
 */
function evaluateConfiguration(hpFreq, hpConfig, lpFreq, lpConfig, errorEvalStartFreq, errorEvalEndFreq) {
  // Create a cache key from the unique parameters of the filter combination.
  const cacheKey = `${hpFreq}-${hpConfig.type}-${hpConfig.slope}-${lpFreq}-${lpConfig.type}-${lpConfig.slope}`;
  let filteredTarget;

  if (state.filterMagnitudeCache.has(cacheKey)) {
    filteredTarget = state.filterMagnitudeCache.get(cacheKey);
  } else {
    filteredTarget = applyFilters(
      state.targetMagnitude,
      state.analysisFrequencies,
      hpFreq,
      hpConfig,
      lpFreq,
      lpConfig
    );
    state.filterMagnitudeCache.set(cacheKey, filteredTarget);
  }

  return calculateVolumeAdjustmentAndError(
    state.subMagnitude,
    filteredTarget,
    state.analysisFrequencies,
    errorEvalStartFreq,
    errorEvalEndFreq,
    state.pointsPerOctave,
    state.analysisStartFreq
  );
}


// --- Worker Message Handlers ---

/**
 * Initializes the worker with the necessary data.
 * @param {object} data - The data payload from the main thread.
 */
function handleInit(data) {
  // Validate input data to ensure robustness.
  if (!data.fixedAnalysisFrequencies || data.fixedAnalysisFrequencies.length === 0) {
    throw new Error('Invalid or missing frequency data for initialization.');
  }

  state.analysisFrequencies = new Float32Array(data.fixedAnalysisFrequencies);
  state.subMagnitude = new Float32Array(data.fixedAnalysisSubMagnitude);
  state.targetMagnitude = new Float32Array(data.fixedAnalysisTargetMagnitude);
  state.pointsPerOctave = data.commonPpo;
  state.analysisStartFreq = data.fixedOverallAnalysisStartFreq;
  state.lowPassCutoffCandidates = data.lpCutoffCandidates;

  const hpSearchStep = data.hpSearchStep;
  const HP_FREQ_MIN = 11;
  const HP_FREQ_MAX = 56;
  state.highPassCutoffCandidates = Array.from(
    { length: Math.floor((HP_FREQ_MAX - HP_FREQ_MIN) / hpSearchStep) + 1 },
    (_, i) => HP_FREQ_MIN + i * hpSearchStep
  );

  state.filterMagnitudeCache.clear();
  console.log('Worker initialized successfully.');
}

/**
 * Processes a batch of filter evaluation tasks.
 * @param {object} data - The batch data from the main thread.
 */
function handleTaskBatch(data) {
  const { tasks, batchId } = data;
  let minErrorForBatch = Infinity;
  let bestResultForBatch = null;

  for (const task of tasks) {
    const { errorEvalStartFreq, errorEvalEndFreq } = task;
    let minErrorForCurrentTask = Infinity;
    let optimalParamsForCurrentTask = {};

    for (const hpFreq of state.highPassCutoffCandidates) {
      for (const lpFreq of state.lowPassCutoffCandidates) {
        if (lpFreq <= hpFreq) continue; // Crossover points must not overlap incorrectly.

        for (const hpConfig of state.highPassFilterConfigs) {
          const currentLpConfig = state.lowPassFilterConfig;

          const { volumeAdjustment, meanAbsoluteError } = evaluateConfiguration(
            hpFreq, hpConfig, lpFreq, currentLpConfig, errorEvalStartFreq, errorEvalEndFreq
          );

          if (meanAbsoluteError < minErrorForCurrentTask) {
            minErrorForCurrentTask = meanAbsoluteError;
            optimalParamsForCurrentTask = {
              highPassFreq: hpFreq,
              highPassConfig: hpConfig,
              lowPassFreq: lpFreq,
              lowPassConfig: currentLpConfig,
              volumeAdjustment: volumeAdjustment,
            };
          }
        }
      }
    }

    if (minErrorForCurrentTask < minErrorForBatch) {
      minErrorForBatch = minErrorForCurrentTask;
      const { highPassFreq, highPassConfig, lowPassFreq, lowPassConfig, volumeAdjustment } = optimalParamsForCurrentTask;
      bestResultForBatch = {
        highPassFreq: highPassFreq,
        highPassSlope: highPassConfig ? highPassConfig.slope : null,
        highPassType: highPassConfig ? highPassConfig.type : null,
        lowPassFreq: lowPassFreq,
        lowPassSlope: lowPassConfig ? lowPassConfig.slope : null,
        lowPassType: lowPassConfig ? lowPassConfig.type : null,
        volumeAdjustment: volumeAdjustment,
        minError: minErrorForCurrentTask,
        optimalErrorRangeStart: errorEvalStartFreq,
        optimalErrorRangeEnd: errorEvalEndFreq,
      };
    }
  }

  self.postMessage({
    type: MESSAGE_TYPE.BATCH_RESULT,
    batchId: batchId,
    result: bestResultForBatch,
  });
}

/**
 * Main message router for the worker.
 */
self.onmessage = function(event) {
  const { type, ...data } = event.data;

  // Use a switch statement for clear and organized message routing.
  switch (type) {
    case MESSAGE_TYPE.INIT:
      handleInit(data);
      break;
    case MESSAGE_TYPE.TASK_BATCH:
      handleTaskBatch(event.data); // Pass the full event.data for simplicity
      break;
    default:
      console.error(`Unknown message type received: ${type}`);
      break;
  }
};