#include "aqua_measure.h"
#include "aqua_camera.h"
#include "aqua_config.h"
#include <math.h>
#include <time.h>

#define MAX_FRAMES 32
#define SAT_LIMIT_PCT 1.0f     // >1% ROI clipped → error
#define DARK_WARN 15.0f        // dark-frame mean above this → light-leak warn
#define BLANK_STALE_S (24*3600)

static long nowSeconds() { return (long)time(nullptr); }

long blankAgeSeconds() {
  if (!g_blank.valid) return -1;
  long now = nowSeconds();
  long age = now - g_blank.timestamp;
  if (age < 0) return -1;        // clock reset since capture → unknown
  return age;
}

static float clampPos(float v) { return v < 1.0f ? 1.0f : v; }

// median of a float array (sorts a copy)
static float medianf(float* a, int n) {
  for (int i = 1; i < n; i++) {   // insertion sort (n small)
    float k = a[i]; int j = i - 1;
    while (j >= 0 && a[j] > k) { a[j+1] = a[j]; j--; }
    a[j+1] = k;
  }
  return a[n/2];
}

String runSequenceJson(bool asBlank) {
  const int N = constrain(g_settings.frame_count, 1, MAX_FRAMES);

  // 1. LED on → discard → settle
  ledOn();
  cameraDiscard(g_settings.discard_frames);
  vTaskDelay(pdMS_TO_TICKS(g_settings.settle_ms));

  // 2. LED off → discard → dark frame
  ledOff();
  cameraDiscard(g_settings.discard_frames);
  RegionResult dark; cameraRegions(dark);

  // 3. LED on → discard → N frames at interval
  ledOn();
  cameraDiscard(g_settings.discard_frames);

  ChannelMeans roiNet[MAX_FRAMES], pANet[MAX_FRAMES], pBNet[MAX_FRAMES];
  float maxSat = 0.0f;
  int got = 0;
  for (int i = 0; i < N; i++) {
    RegionResult f;
    if (cameraRegions(f)) {
      roiNet[got].r = clampPos(f.roi.r - dark.roi.r);
      roiNet[got].g = clampPos(f.roi.g - dark.roi.g);
      roiNet[got].b = clampPos(f.roi.b - dark.roi.b);
      pANet[got].r = clampPos(f.patchA.r - dark.patchA.r);
      pANet[got].g = clampPos(f.patchA.g - dark.patchA.g);
      pANet[got].b = clampPos(f.patchA.b - dark.patchA.b);
      pBNet[got].r = clampPos(f.patchB.r - dark.patchB.r);
      pBNet[got].g = clampPos(f.patchB.g - dark.patchB.g);
      pBNet[got].b = clampPos(f.patchB.b - dark.patchB.b);
      if (f.roiSatPct > maxSat) maxSat = f.roiSatPct;
      got++;
    }
    vTaskDelay(pdMS_TO_TICKS(g_settings.interval_ms));  // yields → feeds WDT
  }
  ledOff();

  // Gate: clipping
  if (maxSat > SAT_LIMIT_PCT) {
    String j = "{\"ok\":false,\"error\":\"clipping — reduce exposure or brightness\",";
    j += "\"saturation_pct\":" + String(maxSat, 2) + "}";
    return j;
  }
  if (got == 0) return "{\"ok\":false,\"error\":\"no frames captured\"}";

  // Averaged net means (robust: median per channel across frames)
  auto medChan = [&](ChannelMeans* arr, char ch) -> float {
    float tmp[MAX_FRAMES];
    for (int i = 0; i < got; i++)
      tmp[i] = (ch=='r')?arr[i].r:(ch=='g')?arr[i].g:arr[i].b;
    return medianf(tmp, got);
  };
  ChannelMeans roiAvg = { medChan(roiNet,'r'), medChan(roiNet,'g'), medChan(roiNet,'b') };
  ChannelMeans pAAvg  = { medChan(pANet,'r'),  medChan(pANet,'g'),  medChan(pANet,'b')  };
  ChannelMeans pBAvg  = { medChan(pBNet,'r'),  medChan(pBNet,'g'),  medChan(pBNet,'b')  };

  // ── /blank: store and return net means ──
  if (asBlank) {
    g_blank.valid = true;
    g_blank.roiNet = roiAvg;
    g_blank.patchANet = pAAvg;
    g_blank.patchBNet = pBAvg;
    g_blank.timestamp = nowSeconds();
    blankSave();
    String j = "{\"ok\":true,";
    j += "\"roi_net\":{\"r\":" + String(roiAvg.r,2) + ",\"g\":" + String(roiAvg.g,2) + ",\"b\":" + String(roiAvg.b,2) + "},";
    j += "\"patchA_net\":{\"r\":" + String(pAAvg.r,2) + ",\"g\":" + String(pAAvg.g,2) + ",\"b\":" + String(pAAvg.b,2) + "},";
    j += "\"patchB_net\":{\"r\":" + String(pBAvg.r,2) + ",\"g\":" + String(pBAvg.g,2) + ",\"b\":" + String(pBAvg.b,2) + "},";
    j += "\"dark_level\":{\"r\":" + String(dark.roi.r,2) + ",\"g\":" + String(dark.roi.g,2) + ",\"b\":" + String(dark.roi.b,2) + "},";
    j += "\"saturation_pct\":" + String(maxSat,2) + ",";
    j += "\"timestamp\":" + String(g_blank.timestamp) + "}";
    return j;
  }

  // ── /measure: need a blank ──
  if (!g_blank.valid) return "{\"ok\":false,\"error\":\"no blank stored — run /blank first\"}";

  // Per-frame absorbance for every channel: A = log10(blank_net / frame_net)
  float aR[MAX_FRAMES], aG[MAX_FRAMES], aB[MAX_FRAMES];
  for (int i = 0; i < got; i++) {
    aR[i] = log10f(g_blank.roiNet.r / roiNet[i].r);
    aG[i] = log10f(g_blank.roiNet.g / roiNet[i].g);
    aB[i] = log10f(g_blank.roiNet.b / roiNet[i].b);
  }

  // Outlier rejection is keyed on the ACTIVE measurement channel — rejecting
  // on a weak channel is worthless: its |A - median| is dominated by noise,
  // which inflates the MAD, widens the tolerance, and lets genuinely bad
  // frames survive.
  float* aSel = (g_channel == CH_RED) ? aR : (g_channel == CH_BLUE) ? aB : aG;

  float tmp[MAX_FRAMES];
  for (int i = 0; i < got; i++) tmp[i] = aSel[i];
  float med = medianf(tmp, got);
  for (int i = 0; i < got; i++) tmp[i] = fabsf(aSel[i] - med);
  float mad = medianf(tmp, got);
  float tol = fmaxf(0.02f, 3.0f * mad);

  bool keep[MAX_FRAMES]; int kept = 0;
  for (int i = 0; i < got; i++) { keep[i] = fabsf(aSel[i] - med) <= tol; if (keep[i]) kept++; }
  if (kept < 3) { for (int i = 0; i < got; i++) keep[i] = true; kept = got; }

  // Average kept per-channel A and net means
  double sA_r = 0, sA_g = 0, sA_b = 0;
  double sRoiR = 0, sRoiG = 0, sRoiB = 0, sPr = 0, sPg = 0, sPb = 0;
  for (int i = 0; i < got; i++) {
    if (!keep[i]) continue;
    sA_r += aR[i]; sA_g += aG[i]; sA_b += aB[i];
    sRoiR += roiNet[i].r; sRoiG += roiNet[i].g; sRoiB += roiNet[i].b;
    sPr += (pANet[i].r + pBNet[i].r) / 2.0;
    sPg += (pANet[i].g + pBNet[i].g) / 2.0;
    sPb += (pANet[i].b + pBNet[i].b) / 2.0;
  }
  float Ar = sA_r / kept, Ag = sA_g / kept, Ab = sA_b / kept;

  // σ for every channel (about that channel's own mean), so the app can show
  // the repeatability of the channel it actually reads.
  auto sigmaOf = [&](float* a, float mean) -> float {
    double var = 0;
    for (int i = 0; i < got; i++) if (keep[i]) var += (a[i] - mean) * (a[i] - mean);
    return sqrtf(var / kept);
  };
  float sigR = sigmaOf(aR, Ar), sigG = sigmaOf(aG, Ag), sigB = sigmaOf(aB, Ab);
  float sigma = (g_channel == CH_RED) ? sigR : (g_channel == CH_BLUE) ? sigB : sigG;

  long age = blankAgeSeconds();

  String j = "{\"ok\":true,";
  j += "\"A_blue\":"  + String(Ab, 4) + ",";
  j += "\"A_red\":"   + String(Ar, 4) + ",";
  j += "\"A_green\":" + String(Ag, 4) + ",";
  j += "\"absorbance_sigma\":" + String(sigma, 4) + ",";   // σ of the ACTIVE channel
  j += "\"channel\":\"" + String(channelName(g_channel)) + "\",";
  j += "\"sigma_red\":" + String(sigR, 4) + ",";
  j += "\"sigma_green\":" + String(sigG, 4) + ",";
  j += "\"sigma_blue\":" + String(sigB, 4) + ",";
  j += "\"raw\":{";
  j +=   "\"roi\":{\"r\":" + String(sRoiR/kept,2) + ",\"g\":" + String(sRoiG/kept,2) + ",\"b\":" + String(sRoiB/kept,2) + "},";
  j +=   "\"patch\":{\"r\":" + String(sPr/kept,2) + ",\"g\":" + String(sPg/kept,2) + ",\"b\":" + String(sPb/kept,2) + "}},";
  j += "\"frames_kept\":" + String(kept) + ",";
  j += "\"frames_total\":" + String(got) + ",";
  j += "\"saturation_pct\":" + String(maxSat, 2) + ",";
  j += "\"dark_level\":{\"r\":" + String(dark.roi.r,2) + ",\"g\":" + String(dark.roi.g,2) + ",\"b\":" + String(dark.roi.b,2) + "},";
  j += "\"blank_age_s\":" + String(age) + ",";
  j += "\"warnings\":[";
  bool first = true;
  if (dark.roi.b > DARK_WARN || dark.roi.r > DARK_WARN || dark.roi.g > DARK_WARN) {
    j += "\"light leak — dark frame is bright\""; first = false;
  }
  if (age < 0 || age > BLANK_STALE_S) {
    if (!first) j += ",";
    j += "\"blank older than 24h — recapture\"";
  }
  j += "]}";
  return j;
}
