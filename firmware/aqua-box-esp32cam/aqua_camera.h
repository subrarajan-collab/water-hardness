#pragma once
#include "aqua_config.h"

struct RegionResult {
  ChannelMeans roi;
  ChannelMeans patchA;
  ChannelMeans patchB;
  ChannelMeans roiP99;   // per-channel 99th-percentile level within the ROI —
                          // the brightness-guidance metric (Bug 1b): a small
                          // number of clipped/hotspot pixels barely move the
                          // MEAN but push the max-channel p99 to 255 well
                          // before the mean looks "bright".
  float roiSatPct;       // % of ROI pixels with any channel >= 250
  bool  ok;
};

bool cameraInit();
void cameraApplyLock();          // apply the locked, linear pipeline from g_settings
void cameraDiscard(int n);       // grab+return n frames (after any setting/LED change)
bool cameraRegions(RegionResult& out);   // one frame → ROI + patch means (+p99 +sat)
bool cameraJpeg(uint8_t** buf, size_t* len);  // current frame → JPEG (caller frees via cameraJpegFree)
void cameraJpegFree(uint8_t* buf);

// Sets aec_value immediately (used by autotune's binary search) without a
// full config save/reload — settings.aec_value is updated in memory so the
// caller can persist it once the search converges.
void cameraSetExposure(int aecValue);

// Binary-searches aec_value (gain fixed at g_settings.agc_gain) until the
// ROI's max-channel p99 lands in [200,230]. Leaves g_settings.aec_value at
// the best value found (caller persists via configSave()). Returns false
// only on a hard capture failure; a search that can't reach the target band
// (e.g. LED off) still returns true with best-effort result.
bool cameraAutoTuneExposure(int& outAecValue, ChannelMeans& outP99);

// Captures ROI mean with LED off, then on. delta = on - off per channel.
bool cameraLedTest(ChannelMeans& offMean, ChannelMeans& onMean);

void ledOn();
void ledOff();
void ledInit();
