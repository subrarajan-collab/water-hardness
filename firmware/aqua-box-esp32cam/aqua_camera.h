#pragma once
#include "aqua_config.h"

struct RegionResult {
  ChannelMeans roi;
  ChannelMeans patchA;
  ChannelMeans patchB;
  float roiSatPct;    // % of ROI pixels with any channel >= 250
  bool  ok;
};

bool cameraInit();
void cameraApplyLock();          // apply the locked, linear pipeline from g_settings
void cameraDiscard(int n);       // grab+return n frames (after any setting/LED change)
bool cameraRegions(RegionResult& out);   // one frame → ROI + patch means (+sat)
bool cameraJpeg(uint8_t** buf, size_t* len);  // current frame → JPEG (caller frees via cameraJpegFree)
void cameraJpegFree(uint8_t* buf);

void ledOn();
void ledOff();
void ledInit();
