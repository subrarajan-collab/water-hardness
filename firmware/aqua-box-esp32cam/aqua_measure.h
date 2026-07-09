#pragma once
#include <Arduino.h>

// Runs the full illuminate → settle → dark → 13-frame capture sequence.
// Builds and returns a JSON string for the given endpoint.
//   asBlank=true  : store net means as the blank (POST /blank)
//   asBlank=false : compute A_ch vs the stored blank (POST /measure)
String runSequenceJson(bool asBlank);
