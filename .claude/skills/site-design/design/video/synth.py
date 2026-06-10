#!/usr/bin/env python3
"""Original, copyright-free hype track for the PipRail promo.
120 BPM EDM build -> drop, synthesized from scratch (pure stdlib). Structure is
timed to the video: ambient intro (0-4s), groove (4-12s), RISER -> DROP at 12s to
hit the chain-storm, full body (12-30s), final build + big outro hit (30-36s)."""
import math, struct, wave, random, array

SR = 44100
DUR = 36.0
N = int(SR * DUR)
random.seed(20260607)

def buf(): return array.array('d', bytes(8 * N))   # zero-filled float64
master_buses = {}
def bus(name):
    if name not in master_buses: master_buses[name] = buf()
    return master_buses[name]

TWO_PI = 2 * math.pi

# ---- one-pole lowpass over a sample list ----
def lowpass(samples, fc):
    rc = 1.0 / (TWO_PI * fc); dt = 1.0 / SR; a = dt / (rc + dt)
    y = 0.0; out = samples
    for i in range(len(out)):
        y += a * (out[i] - y); out[i] = y
    return out

# ---- generic tone: sum of (optionally detuned) oscillators with an AD/ADSR env ----
def tone(target, t0, dur, freqs, amp, wave='saw', attack=0.004, decay=0.12,
         sustain=0.0, release=0.06, lp=None, detune=0.0, voices=1):
    s0 = int(t0 * SR); n = int(dur * SR)
    if n <= 0: return
    # build oscillator phase increments
    oscs = []
    for f in freqs:
        if detune and voices > 1:
            for v in range(voices):
                d = (v - (voices - 1) / 2) * detune
                oscs.append(f * (1 + d))
        else:
            oscs.append(f)
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
            else: s += 2 * ph - 1                       # saw
        s /= len(oscs)
        # envelope
        if i < ka: e = i / ka
        elif i < ka + kd: e = 1 - (1 - sustain) * ((i - ka) / kd)
        elif i < ka + kd + ksus: e = sustain
        else:
            rp = (i - ka - kd - ksus) / kr; e = sustain * (1 - rp)
            if sustain == 0.0:  # percussive: exp decay tail already covered by decay
                e = 0.0
        local[i] = s * e
    if lp: local = lowpass(local, lp)
    for i in range(n):
        idx = s0 + i
        if 0 <= idx < N: target[idx] += local[i] * amp

# ---- noise burst (hats / claps / risers) ----
def noise(target, t0, dur, amp, decay=0.04, lp=None, hp=False, rise=False):
    s0 = int(t0 * SR); n = int(dur * SR)
    if n <= 0: return
    local = [random.uniform(-1, 1) for _ in range(n)]
    if lp:
        if rise:  # sweep cutoff upward across the burst
            y = 0.0
            for i in range(n):
                fc = lp[0] + (lp[1] - lp[0]) * (i / n)
                rc = 1.0 / (TWO_PI * fc); dt = 1.0 / SR; a = dt / (rc + dt)
                y += a * (local[i] - y); local[i] = y
        else:
            local = lowpass(local, lp)
    if hp:  # crude highpass = signal - lowpassed
        lpv = lowpass(local[:], 1200)
        for i in range(n): local[i] -= lpv[i]
    for i in range(n):
        if rise: e = (i / n) ** 1.7           # swell up
        else: e = math.exp(-i / (decay * SR)) # exp decay
        idx = s0 + i
        if 0 <= idx < N: target[idx] += local[i] * amp * e

def kick(target, t0, amp=1.0):
    n = int(0.34 * SR); s0 = int(t0 * SR)
    for i in range(n):
        t = i / SR
        f = 48 + (120 - 48) * math.exp(-t / 0.03)     # pitch drop
        env = math.exp(-t / 0.13)
        s = math.sin(TWO_PI * f * t) * env
        if i < int(0.004 * SR): s += random.uniform(-1, 1) * (1 - i / (0.004 * SR)) * 0.6  # click
        idx = s0 + i
        if 0 <= idx < N: target[idx] += s * amp

# ====================================================================
# ARRANGEMENT
# ====================================================================
BEAT = 60.0 / 128  # 128 BPM — upbeat
BAR = BEAT * 4
def chordsel(name):
    C = {
        'Am': ([220.00, 261.63, 329.63], 110.00, [440.00, 523.25, 659.25]),
        'F':  ([174.61, 220.00, 261.63],  87.31, [349.23, 440.00, 523.25]),
        'C':  ([261.63, 329.63, 392.00], 130.81, [523.25, 659.25, 783.99]),
        'G':  ([196.00, 246.94, 293.66],  98.00, [392.00, 493.88, 587.33]),
    }
    return C[name]
PROG = ['Am','F','C','G','Am','F','Am','F','C','G','Am','F','C','G','Am','F','Am','Am']
def chord_at(bar): return chordsel(PROG[min(bar, len(PROG)-1)])

b_kick = bus('kick'); b_bass = bus('bass'); b_chord = bus('chord')
b_lead = bus('lead'); b_perc = bus('perc'); b_fx = bus('fx'); b_pad = bus('pad')

# --- intro pad (0-4.2): soft Am swell ---
notes, root, _ = chord_at(0)
tone(b_pad, 0.0, 4.2, notes, 0.16, wave='saw', attack=1.4, decay=0.5, sustain=0.8,
     release=1.0, lp=900, detune=0.006, voices=3)

# --- kicks: 4-on-floor 4.0-11.0, gap (build), DROP 12.0-31.5, outro hit 32.0 ---
kick_times = []
t = 4.0
while t < 11.0 - 1e-6: kick_times.append(t); t += BEAT
t = 12.0
while t < 31.5 - 1e-6: kick_times.append(t); t += BEAT
kick_times.append(32.0)
for kt in kick_times: kick(b_kick, kt, amp=1.0 if kt >= 12.0 else 0.82)

# --- bass: off-beat 8ths following the root, where kicks are active ---
def section_active(t):
    return (4.0 <= t < 11.0) or (12.0 <= t < 31.5)
t = 4.0
while t < 31.5:
    if section_active(t):
        bar = int(t // BAR); _, r, _ = chord_at(bar)
        amp = 0.34 if t >= 12.0 else 0.26
        tone(b_bass, t + BEAT/2, BEAT/2 * 0.9, [r, r*2], amp, wave='saw',
             attack=0.006, decay=0.18, sustain=0.0, lp=320, detune=0.004, voices=2)
    t += BEAT

# --- chord stabs ---
# groove 4-12: stab on each beat (filtered); drop 12-30: stabs beats 1&3 + sustained
t = 4.0
while t < 12.0:
    bar = int(t // BAR); notes, _, _ = chord_at(bar)
    tone(b_chord, t, BEAT*0.8, notes, 0.16, wave='saw', attack=0.006, decay=0.22,
         sustain=0.0, lp=1500, detune=0.008, voices=3)
    t += BEAT
t = 12.0
while t < 30.0:
    bar = int(t // BAR); notes, _, _ = chord_at(bar)
    beat_in_bar = round((t - bar*BAR) / BEAT)
    if beat_in_bar in (0, 2):
        tone(b_chord, t, BEAT*0.9, notes, 0.2, wave='saw', attack=0.005, decay=0.3,
             sustain=0.1, release=0.15, lp=2200, detune=0.01, voices=4)
    # sustained airy pad under the drop
    if beat_in_bar == 0:
        tone(b_pad, t, BAR, [n*2 for n in notes], 0.07, wave='saw', attack=0.05,
             decay=0.3, sustain=0.7, release=0.4, lp=2600, detune=0.012, voices=3)
    t += BEAT

# --- lead arp on the drop (16th notes, bright saw, octave-up chord tones) ---
def arp(t0, t1, amp):
    t = t0
    while t < t1:
        bar = int(t // BAR); _, _, up = chord_at(bar)
        step = round((t - t0) / (BEAT/2))
        f = up[step % 3] * (2 if (step % 6) >= 3 else 1)
        tone(b_lead, t, BEAT/2*0.95, [f], amp, wave='saw', attack=0.003, decay=0.11,
             sustain=0.0, lp=5400, detune=0.0)
        t += BEAT/2
arp(12.0, 30.0, 0.15)   # bright lead across the whole drop = more upbeat

# --- hats: closed on 8ths, open accents ---
t = 4.0
while t < 31.5:
    if section_active(t) or (11.0 <= t < 12.0):
        off = abs((t/BEAT) - round(t/BEAT)) > 0.1
        noise(b_perc, t + BEAT/2, 0.035, 0.10, decay=0.02, hp=True)   # off-beat closed hat
        if int(t/BEAT) % 4 == 3:
            noise(b_perc, t, 0.12, 0.07, decay=0.08, hp=True)          # open hat accent
    t += BEAT
# driving 16th-note closed hats through the drop
t = 12.0
while t < 30.0:
    noise(b_perc, t, 0.020, 0.045, decay=0.010, hp=True)
    t += BEAT/2

# --- claps/snare on beats 2 & 4 ---
t = 8.0
while t < 31.5:
    if section_active(t):
        bar = int(t // BAR); beat_in_bar = round((t - bar*BAR)/BEAT)
        if beat_in_bar in (1, 3):
            for d in (0.0, 0.008, 0.016):
                noise(b_perc, t + d, 0.05, 0.16, decay=0.03, lp=5000, hp=True)
            noise(b_perc, t, 0.20, 0.12, decay=0.12, lp=4000, hp=True) # body/tail
    t += BEAT

# --- risers into the drop (10-12) and final build (30-32) ---
noise(b_fx, 10.0, 2.0, 0.18, lp=(400, 9000), rise=True)
tone(b_fx, 10.0, 2.0, [220], 0.05, wave='saw', attack=1.9, decay=0.1, sustain=0.0, lp=3000)
noise(b_fx, 30.0, 2.0, 0.16, lp=(500, 9000), rise=True)
# snare build (accelerating) 30.5-32.0
sd = 30.5; gap = 0.25
while sd < 32.0:
    noise(b_fx, sd, 0.09, 0.13, decay=0.05, lp=5000, hp=True)
    gap *= 0.82; sd += max(gap, 0.06)

# --- impacts/crashes at the drop and the outro ---
def impact(t0, amp=1.0):
    n = int(0.7*SR); s0 = int(t0*SR)
    for i in range(n):
        t = i/SR; env = math.exp(-t/0.5)
        s = math.sin(TWO_PI*46*t)*math.exp(-t/0.25)        # sub boom
        idx = s0+i
        if 0 <= idx < N: target_fx[idx] += s*0.6*amp
    noise(b_fx, t0, 0.9, 0.22*amp, decay=0.45, hp=True)    # crash
target_fx = b_fx
impact(12.0, 1.0)
impact(32.0, 1.1)

# --- big outro chord (32-36) ringing out ---
notes, _, up = chord_at(16)
tone(b_pad, 32.0, 4.0, notes + [n*2 for n in notes], 0.18, wave='saw', attack=0.02,
     decay=0.4, sustain=0.6, release=2.2, lp=2600, detune=0.012, voices=3)
tone(b_bass, 32.0, 3.6, [110.0], 0.3, wave='saw', attack=0.01, decay=0.5, sustain=0.4,
     release=1.5, lp=300, detune=0.004, voices=2)

# ====================================================================
# SIDECHAIN PUMP + MIX
# ====================================================================
duck = array.array('d', bytes(8 * N))
for i in range(N): duck[i] = 1.0
pump_len = int(0.34 * SR)
for kt in kick_times:
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
    mix[i] = math.tanh(s * 1.15)             # soft clip / glue

# normalize to -1.2 dBFS
peak = max(1e-6, max(abs(x) for x in mix))
g = 0.87 / peak
# tiny stereo widen: delay one channel a touch for the perc/lead feel
HAAS = int(0.0004 * SR)
frames = bytearray()
for i in range(N):
    l = mix[i] * g
    r = mix[i - HAAS] * g if i - HAAS >= 0 else mix[i] * g
    li = max(-32767, min(32767, int(l * 32767)))
    ri = max(-32767, min(32767, int(r * 32767)))
    frames += struct.pack('<hh', li, ri)

with wave.open('/Users/john/Sites/piprail/.claude/skills/site-design/design/video/music.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(bytes(frames))
print(f"music.wav written: {DUR}s, peak->{0.87:.2f}, {len(kick_times)} kicks")
