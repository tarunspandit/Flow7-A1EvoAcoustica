function freqToIndex(freq, startFreq, ppo, totalPoints) {
  if (freq < startFreq) return 0;
  const index = ppo * Math.log2(freq / startFreq);
  return Math.min(Math.round(index), totalPoints - 1);
}
function getLRFilterGain(freq, cutoff, lrOrderNumerical, type) {
  if (freq <= 0 || cutoff <= 0 || lrOrderNumerical <= 0) return -200;
  const ratio = freq / cutoff;
  const ratioPow = Math.pow(ratio, lrOrderNumerical);
  let magnitude;
  if (type === 'LP') {
      magnitude = 1 / (1 + ratioPow);
  } else if (type === 'HP') {
      magnitude = ratioPow / (1 + ratioPow);
  }
  if (magnitude <= 1e-10) return -200;
  return 20 * Math.log10(magnitude);
}
function getButterworthFilterGain(freq, cutoff, order, type) {
  if (freq <= 0 || cutoff <= 0 || order <= 0) return -200;
  const ratio = freq / cutoff;
  let magnitude;
  if (type === 'LP') {
      magnitude = 1 / Math.sqrt(1 + Math.pow(ratio, 2 * order));
  } else if (type === 'HP') {
      magnitude = Math.pow(ratio, order) / Math.sqrt(1 + Math.pow(ratio, 2 * order));
  }
  if (magnitude <= 1e-10) return -200;
  return 20 * Math.log10(magnitude);
}
function applyFilters(dataMagnitude, frequencies, hpFreq, hpConfig, lpFreq, lpConfig) {
  const filteredMagnitude = new Float32Array(dataMagnitude.length);
  for (let i = 0; i < dataMagnitude.length; i++) {
    const freq = frequencies[i];
    const originalMag = dataMagnitude[i];
    if (isNaN(originalMag)) {
      filteredMagnitude[i] = NaN;
      continue;
    }
    let hpGain, lpGain;
    if (hpConfig.type === 'L-R') {
        const hpEffectiveOrder = hpConfig.slope / 6;
        hpGain = getLRFilterGain(freq, hpFreq, hpEffectiveOrder, 'HP');
    } else if (hpConfig.type === 'BU') {
        const hpOrder = hpConfig.slope / 6;
        hpGain = getButterworthFilterGain(freq, hpFreq, hpOrder, 'HP');
    } else { 
      hpGain = -200;
    }
    if (lpConfig.type === 'L-R') {
        const lpEffectiveOrder = lpConfig.slope / 6;
        lpGain = getLRFilterGain(freq, lpFreq, lpEffectiveOrder, 'LP');
    } else if (lpConfig.type === 'BU') {
        const lpOrder = lpConfig.slope / 6;
        lpGain = getButterworthFilterGain(freq, lpFreq, lpOrder, 'LP');
    } else { 
      lpGain = -200;
    }
    filteredMagnitude[i] = originalMag + hpGain + lpGain;
  }
  return filteredMagnitude;
}
function calculateVolumeAdjustmentAndError(responseToAdjust, targetMagnitude, frequencies, errorRangeStartFreq, errorRangeEndFreq, ppo, analysisStartFreq) {
  let sumDiff = 0, count = 0, sumAbsoluteDiff = 0;
  const totalPoints = frequencies.length;
  const startIndex = freqToIndex(errorRangeStartFreq, analysisStartFreq, ppo, totalPoints);
  const endIndex = freqToIndex(errorRangeEndFreq, analysisStartFreq, ppo, totalPoints);
  if (startIndex >= totalPoints || endIndex < 0 || startIndex > endIndex) {
    return {volumeAdjustment: 0, maeError: Infinity};
  }
  for (let i = startIndex; i <= endIndex; i++) {
    if (isFinite(responseToAdjust[i]) && isFinite(targetMagnitude[i])) {
      sumDiff += (targetMagnitude[i] - responseToAdjust[i]);
      count++;
    }
  }
  if (count === 0) {
      return {volumeAdjustment: 0, maeError: Infinity};
  }
  const volumeAdjustment = sumDiff / count;
  for (let i = startIndex; i <= endIndex; i++) {
    if (isFinite(responseToAdjust[i]) && isFinite(targetMagnitude[i])) {
      const alignedResponse = responseToAdjust[i] + volumeAdjustment;
      const diff = alignedResponse - targetMagnitude[i];
      sumAbsoluteDiff += Math.abs(diff);
    }
  }
  const maeError = sumAbsoluteDiff / count;
  return {volumeAdjustment, maeError};
}
let fixedAnalysisFrequencies, fixedAnalysisSubMagnitude, fixedAnalysisTargetMagnitude, commonPpo, fixedOverallAnalysisStartFreq, lpCutoffCandidates;
let hpCutoffCandidates; // Will be generated in 'init'
const hpFilterConfigs = [
  {type: 'L-R', slope: 24}, {type: 'L-R', slope: 36}, {type: 'L-R', slope: 48},
  {type: 'BU', slope: 12}, {type: 'BU', slope: 18}, {type: 'BU', slope: 24}, {type: 'BU', slope: 36}, {type: 'BU', slope: 48}
];
const lpFilterConfig = {type: 'L-R', slope: 24};
const filterMagnitudeCache = new Map();

self.onmessage = function(event) {
  if (event.data.type === 'init') {
    fixedAnalysisFrequencies = new Float32Array(event.data.fixedAnalysisFrequencies);
    fixedAnalysisSubMagnitude = new Float32Array(event.data.fixedAnalysisSubMagnitude);
    fixedAnalysisTargetMagnitude = new Float32Array(event.data.fixedAnalysisTargetMagnitude);
    commonPpo = event.data.commonPpo;
    fixedOverallAnalysisStartFreq = event.data.fixedOverallAnalysisStartFreq;
    lpCutoffCandidates = event.data.lpCutoffCandidates;
    
    // Receive hpSearchStep and generate candidates here
    const hpSearchStep = event.data.hpSearchStep;
    hpCutoffCandidates = Array.from({ length: Math.floor((60 - 11) / hpSearchStep) + 1 }, (_, i) => 11 + i * hpSearchStep);

    filterMagnitudeCache.clear();
  } else if (event.data.type === 'taskBatch') {
    const { tasks, batchId } = event.data;
    let minMaeErrorForBatch = Infinity;
    let optimalResultForBatch = null;
    for (const task of tasks) { 
      const { errorEvalStartFreq, errorEvalEndFreq } = task;
      let minMaeErrorForCurrentTask = Infinity;
      let optimalHpFreqForCurrentTask = null;
      let optimalHpConfigForCurrentTask = null;
      let optimalLpFreqForCurrentTask = null;
      let optimalLpConfigForCurrentTask = null;
      let optimalVolumeAdjustmentForCurrentTask = null;
      for (const hpFreq of hpCutoffCandidates) {
        for (const lpFreq of lpCutoffCandidates) {
            if (lpFreq <= hpFreq) continue;
            for (const hpConfig of hpFilterConfigs) {
                const currentLpConfig = lpFilterConfig;
                const cacheKey = hpFreq + '-' + hpConfig.type + '-' + hpConfig.slope + '-' + lpFreq + '-' + currentLpConfig.type + '-' + currentLpConfig.slope;
                let currentFilteredTarget;
                if (filterMagnitudeCache.has(cacheKey)) {
                    currentFilteredTarget = filterMagnitudeCache.get(cacheKey);
                } else {
                    currentFilteredTarget = applyFilters(fixedAnalysisTargetMagnitude, fixedAnalysisFrequencies, hpFreq, hpConfig, lpFreq, currentLpConfig);
                    filterMagnitudeCache.set(cacheKey, currentFilteredTarget);
                }
                const {volumeAdjustment, maeError} = calculateVolumeAdjustmentAndError(
                  fixedAnalysisSubMagnitude,
                  currentFilteredTarget,
                  fixedAnalysisFrequencies,
                  errorEvalStartFreq,
                  errorEvalEndFreq,
                  commonPpo,
                  fixedOverallAnalysisStartFreq
                );
                if (maeError < minMaeErrorForCurrentTask) {
                  minMaeErrorForCurrentTask = maeError;
                  optimalHpFreqForCurrentTask = hpFreq;
                  optimalHpConfigForCurrentTask = hpConfig;
                  optimalLpFreqForCurrentTask = lpFreq;
                  optimalLpConfigForCurrentTask = currentLpConfig;
                  optimalVolumeAdjustmentForCurrentTask = volumeAdjustment;
                }
            }
        }
      }
      if (minMaeErrorForCurrentTask < minMaeErrorForBatch) {
        minMaeErrorForBatch = minMaeErrorForCurrentTask;
        optimalResultForBatch = {
          highPassFreq: optimalHpFreqForCurrentTask,
          highPassSlope: optimalHpConfigForCurrentTask ? optimalHpConfigForCurrentTask.slope : null,
          highPassType: optimalHpConfigForCurrentTask ? optimalHpConfigForCurrentTask.type : null,
          lowPassFreq: optimalLpFreqForCurrentTask,
          lowPassSlope: optimalLpConfigForCurrentTask ? optimalLpConfigForCurrentTask.slope : null,
          lowPassType: optimalLpConfigForCurrentTask ? optimalLpConfigForCurrentTask.type : null,
          volumeAdjustment: optimalVolumeAdjustmentForCurrentTask,
          minError: minMaeErrorForCurrentTask,
          optimalErrorRangeStart: errorEvalStartFreq,
          optimalErrorRangeEnd: errorEvalEndFreq,
        };
      }
    }
    self.postMessage({
      type: 'batchResult',
      batchId: batchId,
      result: optimalResultForBatch
    });
  }
};