#!/usr/bin/env python3
"""
extract_supplement.py — turns the .actor / .arc / .lore files (which the Go
synthesist does not merge — it only merges .ttrpg) into JSON for build_data.py.

Usage: extract_supplement.py <out.json> <npcs.actor> <adventure.arc> <lore-file>...

Output shape:
{
  "npcs": [ {name, hash, kind:"profile"|"statblock", extends, epithet, traits,
             description, statblock:{...} or null}, ... ],
  "locations": [ {name, description}, ... ],
  "phases": [ {name, description, pacing, scene_hashes:[...]}, ... ],
  "scenes": [ {name, hash, type, location, description, read_aloud:[...],
               checks:[...], clues:[...], objectives:{required:[...],optional:[...]},
               conflict:{...}, resolutions:[...], prerequisites:[...]}, ... ],
  "lore_sections": [ {source, title, level, html_paragraphs:[...] } , ...] (per lore file, by heading)
}
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from parse_dsl import parse_file, entities, blocks_by_keyword, values_by_keyword, value, props_dict


def find(body, keyword):
    for s in body:
        if s.get('keyword') == keyword:
            return s
    return None


def findall(body, keyword):
    return [s for s in body if s.get('keyword') == keyword]


def extract_npcs(actor_path):
    tree = parse_file(actor_path)
    top = tree[0]
    out = []
    for e in entities(top['body']):
        extends_stmt = find(e['body'], 'EXTENDS')
        extends = extends_stmt['name'] if extends_stmt else None
        rec = {'name': e['name'], 'hash': e['hash'], 'extends': extends, 'profile': None, 'statblock': None, 'features': []}

        props_block = find(e['body'], 'PROPERTIES')
        if props_block:
            props = props_dict(props_block['body'])
            if extends == 'NPC Profile':
                rec['profile'] = {
                    'epithet': props.get('Epithet'),
                    'traits': props.get('Traits') or [],
                    'description': props.get('Description'),
                }
            elif extends == 'Monster':
                rec['statblock'] = props

        feat_block = find(e['body'], 'FEATURES')
        if feat_block:
            for fe in entities(feat_block['body']):
                fprops_block = find(fe['body'], 'PROPERTIES')
                fprops = props_dict(fprops_block['body']) if fprops_block else props_dict(fe['body'])
                fextends = find(fe['body'], 'EXTENDS')
                rec['features'].append({
                    'name': fe['name'],
                    'category': fprops.get('Category'),
                    'description': fprops.get('Description'),
                })

        # secondary profile boxes (Wynota, Adam, Nikki each get one after their statblock)
        prof_block = find(e['body'], 'PROFILES')
        if prof_block:
            for pe in entities(prof_block['body']):
                pprops_block = find(pe['body'], 'PROPERTIES')
                pprops = props_dict(pprops_block['body']) if pprops_block else props_dict(pe['body'])
                out.append({
                    'name': pe['name'], 'hash': pe['hash'], 'extends': 'NPC Profile',
                    'profile': {
                        'epithet': pprops.get('Epithet'),
                        'traits': pprops.get('Traits') or [],
                        'description': pprops.get('Description'),
                    },
                    'statblock': None, 'features': [],
                    'linked_to': e['hash'],
                })
        out.append(rec)
    return out


def s_or_none(x):
    return x if x else None


def extract_checks(body):
    block = find(body, 'CHECKS')
    if not block:
        return []
    out = []
    for c in entities(block['body']):
        # CHECK entities carry bare value statements directly (no PROPERTIES wrapper)
        skill = value(c['body'], 'SKILL')
        dc = value(c['body'], 'DC')
        on_success = value(c['body'], 'ON_SUCCESS')
        out.append({'name': c['name'], 'skill': skill, 'dc': dc, 'on_success': on_success})
    return out


def extract_clues(body):
    block = find(body, 'CLUES')
    if not block:
        return []
    out = []
    for c in entities(block['body']):
        desc = value(c['body'], 'DESCRIPTION')
        by = value(c['body'], 'DISCOVERED_BY')
        out.append({'name': c['name'], 'description': desc, 'discovered_by': by})
    return out


def extract_objectives(body):
    block = find(body, 'OBJECTIVES')
    if not block:
        return {'required': [], 'optional': []}
    req = values_by_keyword(block['body'], 'REQUIRED')
    opt = values_by_keyword(block['body'], 'OPTIONAL')
    return {'required': req, 'optional': opt}


def extract_resolutions(body):
    block = find(body, 'RESOLUTIONS')
    if not block:
        return []
    out = []
    for r in entities(block['body']):
        cond = value(r['body'], 'CONDITION')
        outcome = value(r['body'], 'OUTCOME')
        leads = find(r['body'], 'LEADS_TO')
        out.append({'name': r['name'], 'condition': cond, 'outcome': outcome,
                     'leads_to': leads['items'] if leads else []})
    return out


def extract_conflict(body):
    block = find(body, 'CONFLICT')
    if not block:
        return None
    typ = value(block['body'], 'TYPE')
    stakes = value(block['body'], 'STAKES')
    rounds = value(block['body'], 'ROUNDS_UNTIL_COMPLETION')
    opp = find(block['body'], 'OPPONENTS')
    return {'type': typ, 'stakes': stakes, 'rounds_until_completion': rounds,
            'opponents': opp['items'] if opp else []}


def extract_arc(arc_path):
    tree = parse_file(arc_path)
    top = tree[0]
    body = top['body']

    themes_block = find(body, 'THEMES')
    themes = [s['value'] for s in themes_block['body'] if s.get('form') == 'bare_str'] if themes_block else []

    description = value(body, 'DESCRIPTION')

    locations = []
    for s in findall(body, 'LOCATION'):
        desc = value(s['body'], 'DESCRIPTION')
        locations.append({'name': s['name'], 'description': desc})

    flow_block = find(body, 'FLOW')
    phases = []
    if flow_block:
        for ph in findall(flow_block['body'], 'PHASE'):
            desc = value(ph['body'], 'DESCRIPTION')
            pacing = value(ph['body'], 'PACING')
            refs = [s.get('hash') for s in findall(ph['body'], 'SCENE_REF')]
            phases.append({'name': ph['name'], 'description': desc, 'pacing': pacing, 'scene_hashes': refs})

    scenes = []
    for s in findall(body, 'SCENE'):
        loc_ref = find(s['body'], 'LOCATION')
        read_aloud_block = find(s['body'], 'READ_ALOUD')
        read_aloud = values_by_keyword(read_aloud_block['body'], 'TEXT') if read_aloud_block else []
        prereq_block = find(s['body'], 'PREREQUISITES')
        prereq = []
        if prereq_block:
            cs = find(prereq_block['body'], 'COMPLETED_SCENES')
            prereq = cs['items'] if cs else []
        scenes.append({
            'name': s['name'], 'hash': s['hash'],
            'type': value(s['body'], 'TYPE'),
            'location': loc_ref['name'] if loc_ref else None,
            'description': value(s['body'], 'DESCRIPTION'),
            'read_aloud': read_aloud,
            'checks': extract_checks(s['body']),
            'clues': extract_clues(s['body']),
            'objectives': extract_objectives(s['body']),
            'conflict': extract_conflict(s['body']),
            'resolutions': extract_resolutions(s['body']),
            'prerequisites': prereq,
        })

    cast_block = find(body, 'CAST')
    cast = []
    if cast_block:
        for fr in findall(cast_block['body'], 'FROM'):
            inc = find(fr['body'], 'INCLUDE')
            cast.append({'from': fr.get('name'), 'hashes': inc['items'] if inc else []})

    return {
        'name': value(body, 'NAME') or top['name'],
        'description': description,
        'themes': themes,
        'locations': locations,
        'phases': phases,
        'scenes': scenes,
        'cast': cast,
    }


def extract_lore(lore_path):
    text = Path(lore_path).read_text(encoding='utf-8')
    lines = text.split('\n')
    sections = []
    cur = None
    for line in lines:
        m = re.match(r'^(#{1,3})\s+(.*)$', line)
        if m and not line.strip().startswith('<!--'):
            level = len(m.group(1))
            title = m.group(2).strip()
            cur = {'level': level, 'title': title, 'paragraphs': []}
            sections.append(cur)
            continue
        if line.strip().startswith('<!--'):
            continue
        if cur is not None and line.strip():
            cur['paragraphs'].append(line.rstrip())
    # merge consecutive non-blank lines that were split by the split('\n') into paragraphs
    # (source uses blank-line-separated paragraphs already; keep as-is, one entry per line
    # is fine — build_data.py rejoins on blank markers) -- simplest: re-derive by blank-line join
    out = []
    for sec in sections:
        paras = []
        buf = []
        for pline in sec['paragraphs']:
            buf.append(pline)
        joined = '\n'.join(buf)
        paras = [p.strip() for p in re.split(r'\n\s*\n', joined) if p.strip()]
        out.append({'title': sec['title'], 'level': sec['level'], 'paragraphs': paras})
    return {'source': Path(lore_path).name, 'sections': out}


def main():
    out_path = sys.argv[1]
    actor_path = sys.argv[2]
    arc_path = sys.argv[3]
    lore_paths = sys.argv[4:]

    data = {
        'npcs': extract_npcs(actor_path),
        'arc': extract_arc(arc_path),
        'lore': [extract_lore(p) for p in lore_paths],
    }
    Path(out_path).write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding='utf-8')
    print(f"wrote {out_path}: {len(data['npcs'])} npc entries, {len(data['arc']['scenes'])} scenes, "
          f"{len(data['arc']['locations'])} locations, {sum(len(l['sections']) for l in data['lore'])} lore sections")


if __name__ == '__main__':
    main()
