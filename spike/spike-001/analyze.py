#!/usr/bin/env python3
"""SPIKE-001 speech 穩定性分析：把 WS 回傳的逐字 speaker 標籤，對上 fixture 的真值分段。

用法: python3 analyze.py spike/results/spike-001-ws-diarize.json [fixtures/two-speakers-turns.json]
"""
import json, sys, collections

res_path = sys.argv[1]
truth_path = sys.argv[2] if len(sys.argv) > 2 else "spike/fixtures/two-speakers-turns.json"
msgs = json.load(open(res_path))["messages"]
truth = json.load(open(truth_path))["turns"]

words = []
for m in msgs:
    if m.get("type") != "Results" or not m.get("is_final"):
        continue
    for w in m.get("channel", {}).get("alternatives", [{}])[0].get("words", []) or []:
        if w.get("start") is not None and w.get("word"):
            words.append(w)
words.sort(key=lambda w: w["start"])
# 去重（同一 start 只留一次，串流的 interim 可能重複回報）
seen, uniq = set(), []
for w in words:
    k = (round(w["start"], 2), w["word"])
    if k in seen:
        continue
    seen.add(k)
    uniq.append(w)
words = uniq

# 依真值分段統計每個 turn 的 speaker 分佈
print(f"逐字總數（去重後）: {len(words)}  |  有 speaker 標籤: {sum(1 for w in words if 'speaker' in w)}")
print(f"{'turn':<5}{'真值':<10}{'預測':<10}{'字數':<6}{'純度':<8}文字")
switch = 0
prev = None
for t in truth:
    seg = [w for w in words if t["start"] - 0.15 <= w["start"] < t["end"] + 0.15]
    cnt = collections.Counter(w.get("speaker") for w in seg)
    top, topn = (cnt.most_common(1) + [(None, 0)])[0]
    purity = f"{topn/len(seg):.0%}" if seg else "n/a"
    text = " ".join((w.get("punctuated_word") or w["word"]) for w in seg)[:44]
    ok = "✓" if top == t["speaker_truth"] else "✗"
    print(f"{t['i']:<5}{t['name'][:6]:<10}{str(top):<10}{len(seg):<6}{purity:<8}{ok} {text}")
    if prev is not None and top != prev:
        switch += 1
    prev = top
print(f"\n偵測到的換人次數: {switch}（真值 5 次，6 句交替）")
print("全域看到的 speaker 值:", sorted({w.get("speaker") for w in words if "speaker" in w}))
