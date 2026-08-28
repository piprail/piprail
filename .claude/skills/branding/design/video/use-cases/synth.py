#!/usr/bin/env python3
"""Original, copyright-free hype track for the PipRail USE-CASES reel.
128 BPM EDM, synthesized from scratch (pure stdlib). Structure is timed to the reel:
quiet intro under the hook (0-3.4s), a groove that BUILDS through the use-case beats
(3.4-30s), a filter-riser into the climax (29.5-32s), the DROP on the chain-storm at
32.0s, full body 32-40s, an outro HIT on the brand reveal at 40.0s, tail to 43s."""
import math, struct, wave, random, array

SR = 44100
DUR = 43.0
N = int(SR * DUR)
random.seed(20260619)

def buf(): return array.array('d', bytes(8 * N))
master_buses = {}
def bus(name):
    if name not in master_buses: master_buses[name] = buf()
    return master_buses[name]

TWO_PI = 2 * math.pi

def lowpass(samples, fc):
    rc = 1.0 / (TWO_PI * fc); dt = 1.0 / SR; a = dt / (rc + dt)
    y = 0.0; out = samples
    for i in range(len(out)):
        y += a * (out[i] - y); out[i] = y
    return out

def tone(target, t0, dur, freqs, amp, wave='saw', attack=0.004, decay=0.12,
         sustain=0.0, release=0.06, lp=None, detune=0.0, voices=1):
    s0 = int(t0 * SR); n = int(dur * SR)
    if n <= 0: return
    oscs = []
    for f in freqs:
        if detune and voices > 1:
            for v in range(voices):
                d = (v - (voices - 1) / 2) * detune
                oscs.append(f * (1 + d))
        else: oscs.append(f)
    phases = [random.random() for _ in oscs]
    incs = [fr / SR for fr in oscs]
    ka = max(1, int(attack * SR)); kd = max(1, int(decay * SR))
    kr = max(1, int(release * SR)); ksus = max(0, n - ka - kd - kr)
    local = [0.0] * n
    for i in range(n):
        s = 0.0
        for j in range(len(oscs)):
            ph = phases[j] + incs[j] * i; ph -= int(ph)
            if wave == 'sine': s += math.sin(TWO_PI * ph)
            elif wave == 'square': s += 1.0 if ph < 0.5 else -1.0
            elif wave == 'tri': s += 4 * abs(ph - 0.5) - 1
            else: s += 2 * ph - 1
        s /= len(oscs)
        if i < ka: e = i / ka
        elif i < ka + kd: e = 1 - (1 - sustain) * ((i - ka) / kd)
        elif i < ka + kd + ksus: e = sustain
        else:
            rp = (i - ka - kd - ksus) / kr; e = sustain * (1 - rp)
            if sustain == 0.0: e = 0.0
        local[i] = s * e
    if lp: local = lowpass(local, lp)
    for i in range(n):
        idx = s0 + i
        if 0 <= idx < N: target[idx] += local[i] * amp

def noise(target, t0, dur, amp, decay=0.04, lp=None, hp=False, rise=False):
    s0 = int(t0 * SR); n = int(dur * SR)
    if n <= 0: return
    local = [random.uniform(-1, 1) for _ in range(n)]
    if lp:
        if rise:
            y = 0.0
            for i in range(n):
                fc = lp[0] + (lp[1] - lp[0]) * (i / n)
                rc = 1.0 / (TWO_PI * fc); dt = 1.0 / SR; a = dt / (rc + dt)
                y += a * (local[i] - y); local[i] = y
        else: local = lowpass(local, lp)
    if hp:
        lpv = lowpass(local[:], 1200)
        for i in range(n): local[i] -= lpv[i]
    for i in range(n):
        if rise: e = (i / n) ** 1.7
        else: e = math.exp(-i / (decay * SR))
        idx = s0 + i
        if 0 <= idx < N: target[idx] += local[i] * amp * e

def kick(target, t0, amp=1.0):
    n = int(0.34 * SR); s0 = int(t0 * SR)
    for i in range(n):
        t = i / SR
        f = 48 + (120 - 48) * math.exp(-t / 0.03)
        env = math.exp(-t / 0.13)
        s = math.sin(TWO_PI * f * t) * env
        if i < int(0.004 * SR): s += random.uniform(-1, 1) * (1 - i / (0.004 * SR)) * 0.6
        idx = s0 + i
        if 0 <= idx < N: target[idx] += s * amp

# ====================================================================
# ARRANGEMENT — build to the DROP at 32.0, outro HIT at 40.0
# ====================================================================
BEAT = 60.0 / 128
BAR = BEAT * 4
def chordsel(name):
    C = {
        'Am': ([220.00, 261.63, 329.63], 110.00, [440.00, 523.25, 659.25]),
        'F':  ([174.61, 220.00, 261.63],  87.31, [349.23, 440.00, 523.25]),
        'C':  ([261.63, 329.63, 392.00], 130.81, [523.25, 659.25, 783.99]),
        'G':  ([196.00, 246.94, 293.66],  98.00, [392.00, 493.88, 587.33]),
    }
    return C[name]
PROG = (['Am', 'F', 'C', 'G'] * 7)
def chord_at(bar): return chordsel(PROG[min(bar, len(PROG) - 1)])

b_kick = bus('kick'); b_bass = bus('bass'); b_chord = bus('chord')
b_lead = bus('lead'); b_perc = bus('perc'); b_fx = bus('fx'); b_pad = bus('pad')

DROP = 32.0; OUTRO = 40.0

# intro pad (0 - 3.6): soft Am swell under the hook
notes, root, _ = chord_at(0)
tone(b_pad, 0.0, 3.6, notes, 0.15, wave='saw', attack=1.3, decay=0.5, sustain=0.8, release=1.0, lp=850, detune=0.006, voices=3)

# kicks: building groove 3.6 -> 30.0, GAP/riser 30-32, DROP 32 -> 40, outro hit 40
kick_times = []
t = 3.6
while t < 30.0 - 1e-6: kick_times.append((t, 'groove')); t += BEAT
t = DROP
while t < OUTRO - 1e-6: kick_times.append((t, 'drop')); t += BEAT
kick_times.append((OUTRO, 'hit'))
for kt, kind in kick_times:
    # groove kicks build amplitude 0.55 -> 0.85 as we approach the drop
    if kind == 'groove': amp = 0.55 + 0.30 * min(1.0, (kt - 3.6) / (30.0 - 3.6))
    elif kind == 'drop': amp = 1.0
    else: amp = 1.05
    kick(b_kick, kt, amp=amp)

def active(t): return (3.6 <= t < 30.0) or (DROP <= t < OUTRO)

# bass: off-beat 8ths on the root where the groove/drop is active
t = 3.6
while t < OUTRO:
    if active(t):
        bar = int(t // BAR); _, r, _ = chord_at(bar)
        amp = 0.34 if t >= DROP else (0.18 + 0.10 * min(1.0, (t - 3.6) / 26.0))
        tone(b_bass, t + BEAT / 2, BEAT / 2 * 0.9, [r, r * 2], amp, wave='saw', attack=0.006, decay=0.18, sustain=0.0, lp=320, detune=0.004, voices=2)
    t += BEAT

# chord stabs: filtered + building through the groove; fuller in the drop + a sustained pad
t = 3.6
while t < 30.0:
    bar = int(t // BAR); notes, _, _ = chord_at(bar)
    cut = 1100 + 1400 * min(1.0, (t - 3.6) / 26.0)   # filter opens as we build
    amp = 0.10 + 0.07 * min(1.0, (t - 3.6) / 26.0)
    tone(b_chord, t, BEAT * 0.8, notes, amp, wave='saw', attack=0.006, decay=0.22, sustain=0.0, lp=cut, detune=0.008, voices=3)
    t += BEAT
t = DROP
while t < OUTRO:
    bar = int(t // BAR); notes, _, _ = chord_at(bar)
    bib = round((t - bar * BAR) / BEAT)
    if bib in (0, 2):
        tone(b_chord, t, BEAT * 0.9, notes, 0.2, wave='saw', attack=0.005, decay=0.3, sustain=0.1, release=0.15, lp=2200, detune=0.01, voices=4)
    if bib == 0:
        tone(b_pad, t, BAR, [n * 2 for n in notes], 0.07, wave='saw', attack=0.05, decay=0.3, sustain=0.7, release=0.4, lp=2600, detune=0.012, voices=3)
    t += BEAT

# bright lead arp across the drop (32-40)
def arp(t0, t1, amp):
    t = t0
    while t < t1:
        bar = int(t // BAR); _, _, up = chord_at(bar)
        step = round((t - t0) / (BEAT / 2))
        f = up[step % 3] * (2 if (step % 6) >= 3 else 1)
        tone(b_lead, t, BEAT / 2 * 0.95, [f], amp, wave='saw', attack=0.003, decay=0.11, sustain=0.0, lp=5400)
        t += BEAT / 2
arp(DROP, OUTRO, 0.15)

# hats: off-beat closed + open accents through the active range; driving 16ths in the drop
t = 3.6
while t < OUTRO:
    if active(t) or (30.0 <= t < DROP):
        noise(b_perc, t + BEAT / 2, 0.035, 0.09, decay=0.02, hp=True)
        if int(t / BEAT) % 4 == 3: noise(b_perc, t, 0.12, 0.06, decay=0.08, hp=True)
    t += BEAT
t = DROP
while t < OUTRO:
    noise(b_perc, t, 0.020, 0.045, decay=0.010, hp=True); t += BEAT / 2

# claps/snare on beats 2 & 4
t = 3.6
while t < OUTRO:
    if active(t):
        bar = int(t // BAR); bib = round((t - bar * BAR) / BEAT)
        if bib in (1, 3):
            for d in (0.0, 0.008, 0.016): noise(b_perc, t + d, 0.05, 0.15, decay=0.03, lp=5000, hp=True)
            noise(b_perc, t, 0.20, 0.11, decay=0.12, lp=4000, hp=True)
    t += BEAT

# risers: a long filter-riser into the DROP (29.0-32), a snare build into the OUTRO hit (38.5-40)
noise(b_fx, 29.0, 3.0, 0.20, lp=(400, 9500), rise=True)
tone(b_fx, 29.5, 2.5, [220], 0.05, wave='saw', attack=2.3, decay=0.1, sustain=0.0, lp=3000)
noise(b_fx, 38.0, 2.0, 0.16, lp=(500, 9000), rise=True)
sd = 38.4; gap = 0.26
while sd < OUTRO - 0.06:   # stop a hair before 40.0 -> a tiny breath, then the slam lands in relief
    noise(b_fx, sd, 0.09, 0.13, decay=0.05, lp=5000, hp=True); gap *= 0.82; sd += max(gap, 0.06)

# impacts/crashes at the DROP (32) and the OUTRO HIT (40)
def impact(t0, amp=1.0, sub=False):
    n = int(0.7 * SR); s0 = int(t0 * SR)
    for i in range(n):
        t = i / SR; s = math.sin(TWO_PI * 46 * t) * math.exp(-t / 0.25)
        idx = s0 + i
        if 0 <= idx < N: b_fx[idx] += s * 0.6 * amp
    if sub:  # deep chest-thump sub sweep — the outro SLAM (60 -> 32 Hz)
        ns = int(1.2 * SR)
        for i in range(ns):
            t = i / SR; f = 60 - 28 * min(1.0, t / 0.55)
            s = math.sin(TWO_PI * f * t) * math.exp(-t / 0.45)
            idx = s0 + i
            if 0 <= idx < N: b_fx[idx] += s * 0.9 * amp
    noise(b_fx, t0, 1.1 if sub else 0.9, (0.26 if sub else 0.22) * amp, decay=0.5 if sub else 0.45, hp=True)
impact(DROP, 1.0)
impact(OUTRO, 1.3, sub=True)

# big outro chord ringing out (40-43)
notes, _, up = chord_at(0)
tone(b_pad, OUTRO, 3.0, notes + [n * 2 for n in notes], 0.18, wave='saw', attack=0.02, decay=0.4, sustain=0.6, release=1.6, lp=2600, detune=0.012, voices=3)
tone(b_bass, OUTRO, 2.8, [110.0], 0.3, wave='saw', attack=0.01, decay=0.5, sustain=0.4, release=1.2, lp=300, detune=0.004, voices=2)

# ====================================================================
# SIDECHAIN PUMP + MIX
# ====================================================================
duck = array.array('d', bytes(8 * N))
for i in range(N): duck[i] = 1.0
pump_len = int(0.34 * SR)
for kt, _kind in kick_times:
    sk = int(kt * SR)
    for j in range(pump_len):
        idx = sk + j
        if idx >= N: break
        v = 0.18 + 0.82 * (j / pump_len) ** 0.55
        if v < duck[idx]: duck[idx] = v

mix = array.array('d', bytes(8 * N))
for i in range(N):
    pumped = (b_bass[i] + b_chord[i] + b_lead[i] + b_pad[i]) * duck[i]
    s = b_kick[i] + b_perc[i] + b_fx[i] + pumped
    s *= 1.05
    mix[i] = math.tanh(s * 1.15)

peak = max(1e-6, max(abs(x) for x in mix))
g = 0.87 / peak
HAAS = int(0.0004 * SR)
# De-click envelope: a tiny fade-IN (kills the start transient) + a smooth cosine fade-OUT over
# the last 0.5s so the outro chord RESOLVES into clean silence — no truncation pop at the end.
FI = int(0.008 * SR); FO = int(0.5 * SR)
frames = bytearray()
for i in range(N):
    env = 1.0
    if i < FI: env = i / FI
    elif i > N - FO: env = 0.5 * (1 + math.cos(math.pi * (i - (N - FO)) / FO))
    l = mix[i] * g * env
    r = (mix[i - HAAS] if i - HAAS >= 0 else mix[i]) * g * env
    li = max(-32767, min(32767, int(l * 32767)))
    ri = max(-32767, min(32767, int(r * 32767)))
    frames += struct.pack('<hh', li, ri)

import os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'music.wav')
with wave.open(OUT, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(bytes(frames))
print(f"music.wav written: {DUR}s, {len(kick_times)} kicks, DROP@{DROP}s OUTRO@{OUTRO}s -> {OUT}")
