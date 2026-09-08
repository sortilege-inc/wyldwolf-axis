#!/usr/bin/env python3
"""
build_data.py — combine the synthesist's resolved.json (all .ttrpg DEFs,
merged/flattened across base + axis-preview + axis-mikko) with the
supplementary JSON extracted from .actor/.arc/.lore (extract_supplement.py)
into data/data.js as window.AXIS.

Usage: build_data.py <resolved.json> <supplement.json> <out data.js>
"""
import json
import sys
from pathlib import Path

# extends values -> bucket. Anything not listed falls into 'rules' (the
# glossary/reference catch-all) rather than being dropped, so nothing new
# the source adds silently disappears from the UI.
BUCKET_BY_EXTENDS = {
    'Spell': 'spells',
    'Monster': 'adversaries',
    'Creature': 'adversaries',
    'Subclass': 'subclasses',
    'Magic Item': 'items',
    'Adventuring Gear': 'items',
    'Weapon': 'items',
    'Armor': 'items',
}
RULES_EXTENDS = {
    'Glossary Rule', 'Toolbox Entry', 'Condition', 'Skill', 'Feat', 'Class',
    'Species', 'Background', 'Weapon Property', 'Weapon Mastery Property', 'Table',
}


def flatten_props(props):
    out = {}
    for p in props or []:
        name = p.get('name')
        if name is None:
            continue
        if 'nested' in p:
            out[name] = flatten_props(p['nested'])
        elif 'value' in p:
            out[name] = p['value']
    return out


def features_from_blocks(blocks):
    for b in blocks or []:
        if b.get('keyword') == 'FEATURES':
            out = []
            for f in b.get('entities', []):
                refs = f.get('refs') or []
                text = f.get('text') or []
                d = dict(zip(refs, text))
                out.append({
                    'name': f.get('name'),
                    'category': d.get('Category'),
                    'description': d.get('Description') or (f.get('constraint') or {}).get('value'),
                })
            return out
    return []


def is_thirdparty(sources):
    return any('wyldwolf' in s or 'axis-mikko' in s or 'axis-preview' in s for s in (sources or []))


def is_artifact_source(sources):
    return any('artifacts' in s for s in (sources or []))


def is_mikko_source(sources):
    return any('axis-mikko' in s for s in (sources or []))


def entity_record(e):
    props = flatten_props(e.get('properties'))
    return {
        'name': e['name'],
        'hash': e.get('hash'),
        'extends': e.get('extends'),
        'sources': e.get('sources', []),
        'thirdParty': is_thirdparty(e.get('sources')),
        'mikko': is_mikko_source(e.get('sources')),
        'properties': props,
        'features': features_from_blocks(e.get('blocks')),
    }


def bucket_of(e):
    ext = e.get('extends')
    if ext in BUCKET_BY_EXTENDS:
        b = BUCKET_BY_EXTENDS[ext]
        if b == 'items' and ext == 'Magic Item' and is_artifact_source(e.get('sources')):
            return 'artifacts'
        return b
    if ext in RULES_EXTENDS:
        return 'rules'
    return 'rules'  # catch-all: nothing silently dropped


def main():
    resolved_path, supp_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    resolved = json.loads(Path(resolved_path).read_text(encoding='utf-8'))
    supp = json.loads(Path(supp_path).read_text(encoding='utf-8'))

    entities = [e for e in resolved['entities'] if e.get('kind') == 'def']

    buckets = {'rules': [], 'spells': [], 'items': [], 'adversaries': [], 'subclasses': [], 'artifacts': []}
    for e in entities:
        buckets[bucket_of(e)].append(entity_record(e))

    for k in buckets:
        buckets[k].sort(key=lambda r: r['name'])

    # NPCs: merge profile + statblock rows that point at the same character
    # (Wynota/Adam/Nikki: a "before" profile row + linked "after" profile row
    # + the Monster-extending statblock row all share intent but are three
    # separate DEFs in source; keep them as-authored, distinct rows, and let
    # the UI group by name).
    npcs = supp['npcs']

    data = {
        'meta': {
            'title': 'The Exorcism of Mikko',
            'subtitle': supp['arc'].get('name') or 'The Exorcism of Mikko',
            'system': 'D&D 5.5e SRD compatible (Wyldwolf Axis)',
            'setting': 'The Axis Saga: War of Silence',
            'publisher': 'Badwolf Studios (adventure); Wyldwolf Games (setting)',
            'edition': resolved.get('edition'),
            'specVersion': resolved.get('spec_version'),
            'entityCount': resolved.get('entity_count'),
            'counts': {
                'rules': len(buckets['rules']),
                'spells': len(buckets['spells']),
                'items': len(buckets['items']),
                'adversaries': len(buckets['adversaries']),
                'subclasses': len(buckets['subclasses']),
                'artifacts': len(buckets['artifacts']),
                'npcs': len(npcs),
                'scenes': len(supp['arc']['scenes']),
                'locations': len(supp['arc']['locations']),
                'phases': len(supp['arc']['phases']),
            },
        },
        'rules': buckets['rules'],
        'spells': buckets['spells'],
        'items': buckets['items'],
        'adversaries': buckets['adversaries'],
        'subclasses': buckets['subclasses'],
        'artifacts': buckets['artifacts'],
        'npcs': npcs,
        'adventures': {
            'mikko': supp['arc'],
        },
        'lore': supp['lore'],
    }

    js = ("/* Generated by build/build_data.py — do not edit by hand.\n"
          "   Sources: titterpig-dsl-dnd5.5e/0.4 (SRD base) + "
          "titterpig-dsl-dnd5e-3rdparty/wyldwolf/5.5/{axis-preview,axis-mikko}\n"
          "   Rules/statblock/spell/item/NPC/scene text is verbatim from the DSL corpus; "
          "regenerate rather than patch. */\n"
          "window.AXIS = " + json.dumps(data, ensure_ascii=False) + ";\n")
    Path(out_path).write_text(js, encoding='utf-8')

    c = data['meta']['counts']
    print(f"wrote {out_path}: rules={c['rules']} spells={c['spells']} items={c['items']} "
          f"adversaries={c['adversaries']} subclasses={c['subclasses']} artifacts={c['artifacts']} "
          f"npcs={c['npcs']} scenes={c['scenes']} locations={c['locations']} phases={c['phases']}")


if __name__ == '__main__':
    main()
