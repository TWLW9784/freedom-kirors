#!/usr/bin/env python3
"""统计 kiro-rs 的 prompt cache 命中率。

数据源：仓库根目录下的 usage_log.YYYY-MM-DD.jsonl
口径：
  - token 级命中率 = cache_read / (input + cache_creation + cache_read)
  - 请求级命中率   = (cache_read>0 的请求数) / 总请求数

用法：
  ./tools/cache_hit_rate.py                      # 全部日志
  ./tools/cache_hit_rate.py --since 2026-06-13   # 指定起始日期
  ./tools/cache_hit_rate.py --since 2026-06-13 --until 2026-06-24
  ./tools/cache_hit_rate.py --model claude-opus-4-8   # 仅某模型
  ./tools/cache_hit_rate.py --json               # 机器可读输出
"""
import argparse
import glob
import json
import os
import sys
from collections import defaultdict

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def parse_args():
    p = argparse.ArgumentParser(description="kiro-rs prompt cache 命中率统计")
    p.add_argument("--since", help="起始日期 YYYY-MM-DD（含）")
    p.add_argument("--until", help="结束日期 YYYY-MM-DD（含）")
    p.add_argument("--model", help="只统计指定模型")
    p.add_argument("--dir", default=REPO_ROOT, help="usage_log 所在目录（默认仓库根）")
    p.add_argument("--json", action="store_true", help="输出 JSON")
    return p.parse_args()


def date_of(path):
    base = os.path.basename(path)
    return base.replace("usage_log.", "").replace(".jsonl", "")


def acc():
    return {"n": 0, "succ": 0, "input": 0, "creation": 0, "read": 0,
            "output": 0, "hit_reqs": 0}


def add(a, r):
    a["n"] += 1
    if r.get("status") == "success":
        a["succ"] += 1
    rd = r.get("cacheReadTokens", 0) or 0
    a["input"] += r.get("inputTokens", 0) or 0
    a["creation"] += r.get("cacheCreationTokens", 0) or 0
    a["read"] += rd
    a["output"] += r.get("outputTokens", 0) or 0
    if rd > 0:
        a["hit_reqs"] += 1


def rates(a):
    prompt = a["input"] + a["creation"] + a["read"]
    token_hit = (a["read"] / prompt * 100) if prompt else 0.0
    req_hit = (a["hit_reqs"] / a["n"] * 100) if a["n"] else 0.0
    return prompt, token_hit, req_hit


def main():
    args = parse_args()
    files = sorted(glob.glob(os.path.join(args.dir, "usage_log.*.jsonl")))
    if not files:
        print(f"未找到 usage_log: {args.dir}", file=sys.stderr)
        sys.exit(1)

    per_day = {}
    total = acc()
    for f in files:
        d = date_of(f)
        if args.since and d < args.since:
            continue
        if args.until and d > args.until:
            continue
        day = acc()
        for line in open(f):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if args.model and r.get("model") != args.model:
                continue
            add(day, r)
            add(total, r)
        if day["n"]:
            per_day[d] = day

    if args.json:
        out = {"days": {}, "total": {}}
        for d, a in per_day.items():
            prompt, th, rh = rates(a)
            out["days"][d] = {**a, "prompt": prompt,
                              "token_hit_pct": round(th, 2),
                              "req_hit_pct": round(rh, 2)}
        prompt, th, rh = rates(total)
        out["total"] = {**total, "prompt": prompt,
                        "token_hit_pct": round(th, 2),
                        "req_hit_pct": round(rh, 2)}
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return

    hdr = f"{'日期':<12}{'请求':>7}{'命中请求':>9}{'input':>13}{'creation':>12}{'read':>13}{'token命中%':>12}{'请求命中%':>11}"
    print(hdr)
    print("-" * len(hdr))
    for d in sorted(per_day):
        a = per_day[d]
        prompt, th, rh = rates(a)
        print(f"{d:<12}{a['n']:>7}{a['hit_reqs']:>9}{a['input']:>13,}"
              f"{a['creation']:>12,}{a['read']:>13,}{th:>11.1f}%{rh:>10.1f}%")
    print("=" * len(hdr))
    prompt, th, rh = rates(total)
    print(f"{'合计':<12}{total['n']:>7}{total['hit_reqs']:>9}{total['input']:>13,}"
          f"{total['creation']:>12,}{total['read']:>13,}{th:>11.1f}%{rh:>10.1f}%")
    if prompt:
        print(f"\nprompt总量 = {prompt:,}")
        print(f"token级命中率 = {th:.2f}%  (read / prompt)")
        print(f"creation占比  = {total['creation']/prompt*100:.2f}%")
        print(f"纯input占比   = {total['input']/prompt*100:.2f}%")
        print(f"请求级命中率  = {total['hit_reqs']}/{total['n']} = {rh:.1f}%")


if __name__ == "__main__":
    main()
