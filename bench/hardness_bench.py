"""
Water Hardness Bench Tester (Python / Logitech webcam)
=======================================================
Desktop twin of the mobile app's measurement pipeline, for optics/parameter
optimisation. Same maths as the app (src/utils/colorAnalysis.js):

  - timed capture run with warm-up discard
  - circular ROI, mean RGB inside the disc
  - median + MAD outlier rejection across frames
  - blueScore / blueDominance / sigma stability metric
  - piecewise-linear calibration -> ppm CaCO3
  - PLUS bench-only extras: manual exposure/WB lock, blank (I0) reading,
    absorbance A = log10(I0/I), CSV logging of every run

Usage:
  python hardness_bench.py [camera_index]

Keys (in the preview window):
  arrows / WASD  move ROI          + / -   resize ROI
  e              toggle auto-exposure
  [ / ]          exposure down/up (when manual)
  u              toggle auto white balance
  m              run a 30 s measurement
  b              run a blank (I0) measurement (plain water tube)
  c              save last measurement as calibration point (asks ppm)
  x              clear calibration
  q / Esc        quit

Outputs (created next to this script):
  bench_calibration.json   calibration points
  bench_history.csv        one row per measurement run
"""

import cv2
import numpy as np
import json
import csv
import os
import sys
import time
from datetime import datetime

# ---------------- parameters (mirror the mobile app) ----------------
TOTAL_SECONDS = 30
CAPTURE_EVERY_N_SECONDS = 2
WARMUP_SECONDS = 5
MAD_TOLERANCE_FLOOR = 8       # reject frame if |blue - median| > max(8, 3*MAD)
MIN_KEPT_FRAMES = 3

HERE = os.path.dirname(os.path.abspath(__file__))
CAL_FILE = os.path.join(HERE, 'bench_calibration.json')
HISTORY_FILE = os.path.join(HERE, 'bench_history.csv')


# ---------------- analysis (same maths as colorAnalysis.js) ----------------
def analyze_circle(frame_bgr, cx, cy, radius):
    """Mean RGB inside the circular ROI. Returns dict like the app's analyzer."""
    h, w = frame_bgr.shape[:2]
    y, x = np.ogrid[:h, :w]
    mask = (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
    count = int(mask.sum())
    if count == 0:
        return None
    b = float(frame_bgr[:, :, 0][mask].mean())
    g = float(frame_bgr[:, :, 1][mask].mean())
    r = float(frame_bgr[:, :, 2][mask].mean())
    total = r + g + b
    return {
        'r': round(r, 2), 'g': round(g, 2), 'b': round(b, 2),
        'blueScore': round(b, 2),
        'blueDominance': round(b / total * 100, 1) if total > 0 else 0.0,
        'pixelCount': count,
    }


def average_results(all_results):
    """Median+MAD outlier rejection, then average. Mirrors averageAnalysisResults()."""
    if not all_results:
        return None
    results = all_results
    rejected = 0
    if len(all_results) >= 5:
        scores = sorted(r['blueScore'] for r in all_results)
        median = scores[len(scores) // 2]
        mad = sorted(abs(s - median) for s in scores)[len(scores) // 2]
        tol = max(MAD_TOLERANCE_FLOOR, 3 * mad)
        kept = [r for r in all_results if abs(r['blueScore'] - median) <= tol]
        if len(kept) >= MIN_KEPT_FRAMES:
            rejected = len(all_results) - len(kept)
            results = kept
    n = len(results)
    avg = {k: sum(r[k] for r in results) / n for k in ('r', 'g', 'b')}
    total = avg['r'] + avg['g'] + avg['b']
    blue = avg['b']
    var = sum((r['blueScore'] - blue) ** 2 for r in results) / n
    return {
        'r': round(avg['r'], 2), 'g': round(avg['g'], 2), 'b': round(avg['b'], 2),
        'blueScore': round(blue, 2),
        'blueDominance': round(blue / total * 100, 1) if total > 0 else 0.0,
        'frameCount': n,
        'rejectedFrames': rejected,
        'blueScoreStdDev': round(var ** 0.5, 2),
        'pixelCount': results[0]['pixelCount'],
    }


def compute_hardness(blue_score, points):
    """Piecewise-linear interpolation/extrapolation. Mirrors computeHardness()."""
    if len(points) < 2:
        return None
    pts = sorted(points, key=lambda p: p['blueScore'])
    bs = blue_score
    if bs <= pts[0]['blueScore']:
        p1, p2 = pts[0], pts[1]
    elif bs >= pts[-1]['blueScore']:
        p1, p2 = pts[-2], pts[-1]
    else:
        p1, p2 = next((pts[i], pts[i + 1]) for i in range(len(pts) - 1)
                      if pts[i]['blueScore'] <= bs <= pts[i + 1]['blueScore'])
    if p2['blueScore'] == p1['blueScore']:
        return None
    slope = (p2['hardness'] - p1['hardness']) / (p2['blueScore'] - p1['blueScore'])
    return max(0.0, round(p1['hardness'] + slope * (bs - p1['blueScore']), 1))


# ---------------- persistence ----------------
def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def save_json(path, data):
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)


def append_history(row):
    exists = os.path.exists(HISTORY_FILE)
    with open(HISTORY_FILE, 'a', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(row.keys()))
        if not exists:
            w.writeheader()
        w.writerow(row)


# ---------------- camera helpers ----------------
def open_camera(index):
    # CAP_DSHOW opens fast on Windows and exposes Logitech manual controls
    cap = cv2.VideoCapture(index, cv2.CAP_DSHOW)
    if not cap.isOpened():
        cap = cv2.VideoCapture(index)
    if not cap.isOpened():
        return None
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    return cap


def set_auto_exposure(cap, enabled):
    # DirectShow convention: 0.75 = auto, 0.25 = manual
    cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.75 if enabled else 0.25)


def describe_camera(cap):
    return ('exposure={:.1f} auto_exp={:.2f} wb_auto={:.0f} gain={:.0f}'
            .format(cap.get(cv2.CAP_PROP_EXPOSURE),
                    cap.get(cv2.CAP_PROP_AUTO_EXPOSURE),
                    cap.get(cv2.CAP_PROP_AUTO_WB),
                    cap.get(cv2.CAP_PROP_GAIN)))


# ---------------- measurement run ----------------
def run_measurement(cap, cx, cy, radius, label='sample'):
    print(f"\n=== {label} run: {TOTAL_SECONDS}s, warm-up {WARMUP_SECONDS}s, "
          f"1 frame / {CAPTURE_EVERY_N_SECONDS}s ===")
    results = []
    start = time.time()
    next_capture = WARMUP_SECONDS + CAPTURE_EVERY_N_SECONDS
    while True:
        ok, frame = cap.read()
        if not ok:
            print('!! camera read failed'); break
        elapsed = time.time() - start
        vis = frame.copy()
        color = (0, 165, 255) if elapsed < WARMUP_SECONDS else (0, 255, 0)
        cv2.circle(vis, (cx, cy), radius, color, 2)
        cv2.putText(vis, f'{label}: {elapsed:4.1f}s  frames:{len(results)}',
                    (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        cv2.imshow('bench', vis)
        if cv2.waitKey(1) & 0xFF in (ord('q'), 27):
            print('aborted'); return None
        if elapsed >= next_capture:
            res = analyze_circle(frame, cx, cy, radius)
            if res:
                if not results and res['r'] + res['g'] + res['b'] < 30:
                    print('!! ROI is dark - LED off or ROI misplaced. Aborting.')
                    return None
                results.append(res)
                print(f"  t={elapsed:4.1f}s  R={res['r']:6.1f} G={res['g']:6.1f} "
                      f"B={res['b']:6.1f}  blue%={res['blueDominance']}")
            next_capture += CAPTURE_EVERY_N_SECONDS
        if elapsed >= TOTAL_SECONDS:
            break
    avg = average_results(results)
    if avg:
        print(f"--- {label} result: blueScore={avg['blueScore']}  "
              f"dominance={avg['blueDominance']}%  sigma={avg['blueScoreStdDev']}  "
              f"kept {avg['frameCount']}/{avg['frameCount']+avg['rejectedFrames']} frames")
    return avg


# ---------------- main ----------------
def main():
    cam_index = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    cap = open_camera(cam_index)
    if cap is None:
        print(f'Could not open camera {cam_index}. Try other indices: '
              f'python hardness_bench.py 1')
        return
    print('Camera opened.', describe_camera(cap))
    print(__doc__.split('Keys')[1].split('Outputs')[0])

    cal = load_json(CAL_FILE, [])
    blank = load_json(os.path.join(HERE, 'bench_blank.json'), None)
    auto_exp = True
    exposure = cap.get(cv2.CAP_PROP_EXPOSURE) or -6
    cx, cy, radius = 640, 360, 110
    last = None

    while True:
        ok, frame = cap.read()
        if not ok:
            print('camera read failed'); break
        h, w = frame.shape[:2]
        cx = min(max(cx, radius), w - radius)
        cy = min(max(cy, radius), h - radius)

        vis = frame.copy()
        cv2.circle(vis, (cx, cy), radius, (246, 182, 41), 2)
        live = analyze_circle(cv2.resize(frame, (w // 4, h // 4)),
                              cx // 4, cy // 4, radius // 4)
        lines = [f"ROI r={radius}  auto_exp={'ON' if auto_exp else f'OFF ({exposure:.0f})'}",
                 f"live R={live['r']:.0f} G={live['g']:.0f} B={live['b']:.0f} "
                 f"blue%={live['blueDominance']}" if live else '',
                 f"cal points: {len(cal)}   blank: "
                 f"{'set (B=%.1f)' % blank['blueScore'] if blank else 'none'}"]
        if last:
            ppm = compute_hardness(last['blueScore'], cal)
            lines.append(f"last: blue={last['blueScore']} sigma={last['blueScoreStdDev']}"
                         + (f'  ppm={ppm}' if ppm is not None else ''))
            if blank and last['blueScore'] > 0:
                absorb = np.log10(blank['blueScore'] / last['blueScore'])
                lines.append(f'absorbance A=log10(I0/I) = {absorb:.4f}')
        for i, t in enumerate(l for l in lines if l):
            cv2.putText(vis, t, (10, 30 + 28 * i), cv2.FONT_HERSHEY_SIMPLEX,
                        0.7, (255, 255, 255), 2)
        cv2.imshow('bench', vis)

        k = cv2.waitKey(30) & 0xFF
        if k in (ord('q'), 27):
            break
        elif k in (81, ord('a')): cx -= 10
        elif k in (83, ord('d')): cx += 10
        elif k in (82, ord('w')): cy -= 10
        elif k in (84, ord('s')): cy += 10
        elif k in (ord('+'), ord('=')): radius = min(radius + 5, 400)
        elif k == ord('-'): radius = max(radius - 5, 20)
        elif k == ord('e'):
            auto_exp = not auto_exp
            set_auto_exposure(cap, auto_exp)
            print('auto exposure:', auto_exp, '|', describe_camera(cap))
        elif k == ord('['):
            exposure -= 1; cap.set(cv2.CAP_PROP_EXPOSURE, exposure)
            print('exposure', exposure)
        elif k == ord(']'):
            exposure += 1; cap.set(cv2.CAP_PROP_EXPOSURE, exposure)
            print('exposure', exposure)
        elif k == ord('u'):
            cur = cap.get(cv2.CAP_PROP_AUTO_WB)
            cap.set(cv2.CAP_PROP_AUTO_WB, 0 if cur else 1)
            print('auto WB:', not cur)
        elif k == ord('m') or k == ord('b'):
            is_blank = (k == ord('b'))
            res = run_measurement(cap, cx, cy, radius,
                                  'BLANK' if is_blank else 'sample')
            if res:
                row = {'time': datetime.now().isoformat(timespec='seconds'),
                       'type': 'blank' if is_blank else 'sample', **res,
                       'auto_exp': auto_exp, 'exposure': exposure,
                       'roi': f'{cx},{cy},r{radius}'}
                if is_blank:
                    blank = res
                    save_json(os.path.join(HERE, 'bench_blank.json'), blank)
                else:
                    last = res
                    ppm = compute_hardness(res['blueScore'], cal)
                    row['ppm'] = ppm if ppm is not None else ''
                    if blank and res['blueScore'] > 0:
                        row['absorbance'] = round(
                            float(np.log10(blank['blueScore'] / res['blueScore'])), 4)
                append_history(row)
                print('logged to', HISTORY_FILE)
        elif k == ord('c'):
            if not last:
                print('run a measurement (m) first'); continue
            try:
                ppm_in = float(input(f"known ppm for blueScore {last['blueScore']}: "))
            except ValueError:
                print('invalid'); continue
            cal.append({'blueScore': last['blueScore'], 'hardness': ppm_in,
                        'createdAt': datetime.now().isoformat(timespec='seconds')})
            save_json(CAL_FILE, cal)
            print(f'calibration point added ({len(cal)} total)')
        elif k == ord('x'):
            cal = []; save_json(CAL_FILE, cal); print('calibration cleared')

    cap.release()
    cv2.destroyAllWindows()


if __name__ == '__main__':
    main()
