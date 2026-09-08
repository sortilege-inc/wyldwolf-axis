#!/usr/bin/env python3
"""
verify_data.py — content/coverage gate. Fails loudly rather than shipping a
data.js that quietly lost content: every synthesist DEF must land in exactly
one bucket of window.AXIS, every supplement NPC/scene/location must survive
into data.js, and the entity_count in resolved.json must reconcile with what
build_data.py actually bucketed.

Usage: verify_data.py <resolved.json> <supplement.json> <data.js>
"""
import json
import re
import sys
from pathlib import Path


def load_axis(data_js_path):
    text = Path(data_js_path).read_text(encoding='utf-8')
    m = re.search(r'window\.AXIS\s*=\s*(\{.*\});\s*$', text, re.S)
    if not m:
        raise SystemExit("verify_data.py: could not find 'window.AXIS = {...};' in " + data_js_path)
    return json.loads(m.group(1))


def main():
    resolved_path, supp_path, data_js_path = sys.argv[1], sys.argv[2], sys.argv[3]
    resolved = json.loads(Path(resolved_path).read_text(encoding='utf-8'))
    supp = json.loads(Path(supp_path).read_text(encoding='utf-8'))
    axis = load_axis(data_js_path)

    errors = []

    def_entities = [e for e in resolved['entities'] if e.get('kind') == 'def']
    non_def = [e for e in resolved['entities'] if e.get('kind') != 'def']

    bucket_keys = ['rules', 'spells', 'items', 'adversaries', 'subclasses', 'artifacts']
    bucketed_names = set()
    bucketed_count = 0
    for k in bucket_keys:
        for row in axis[k]:
            key = (row['hash'], row['name'])
            if key in bucketed_names:
                errors.append(f"duplicate entity across buckets: {row['name']} ({row['hash']})")
            bucketed_names.add(key)
            bucketed_count += 1

    if bucketed_count != len(def_entities):
        errors.append(
            f"bucket coverage: resolved.json has {len(def_entities)} kind=def entities, "
            f"data.js buckets hold {bucketed_count} — {len(def_entities) - bucketed_count} missing/extra"
        )

    resolved_names = {(e.get('hash'), e['name']) for e in def_entities}
    missing = resolved_names - bucketed_names
    if missing:
        sample = sorted(list(missing))[:10]
        errors.append(f"{len(missing)} resolved entities absent from every data.js bucket, e.g. {sample}")

    # supplement coverage: every NPC / scene / location / lore section must survive verbatim-by-count
    if len(axis['npcs']) != len(supp['npcs']):
        errors.append(f"npcs: supplement has {len(supp['npcs'])}, data.js has {len(axis['npcs'])}")
    if len(axis['adventures']['mikko']['scenes']) != len(supp['arc']['scenes']):
        errors.append("scenes count mismatch between supplement and data.js")
    if len(axis['adventures']['mikko']['locations']) != len(supp['arc']['locations']):
        errors.append("locations count mismatch between supplement and data.js")
    if len(axis['lore']) != len(supp['lore']):
        errors.append("lore file count mismatch between supplement and data.js")
    supp_lore_sections = sum(len(l['sections']) for l in supp['lore'])
    axis_lore_sections = sum(len(l['sections']) for l in axis['lore'])
    if supp_lore_sections != axis_lore_sections:
        errors.append(f"lore section count mismatch: supplement={supp_lore_sections} data.js={axis_lore_sections}")

    # sanity: meta.entityCount should equal resolved entity_count
    if axis['meta']['entityCount'] != resolved['entity_count']:
        errors.append(f"meta.entityCount {axis['meta']['entityCount']} != resolved entity_count {resolved['entity_count']}")

    print(f"resolved.json: {len(def_entities)} def entities, {len(non_def)} non-def ({[e.get('kind') for e in non_def]})")
    print(f"data.js buckets: " + ", ".join(f"{k}={len(axis[k])}" for k in bucket_keys) + f", total={bucketed_count}")
    print(f"supplement: npcs={len(supp['npcs'])} scenes={len(supp['arc']['scenes'])} "
          f"locations={len(supp['arc']['locations'])} lore_sections={supp_lore_sections}")

    if errors:
        print("\nFAILED:")
        for e in errors:
            print(" -", e)
        sys.exit(1)
    print("\nverify_data.py: 0 discrepancies")


if __name__ == '__main__':
    main()
