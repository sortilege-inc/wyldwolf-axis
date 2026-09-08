#!/usr/bin/env python3
"""
parse_dsl.py — generic tokenizer + tree parser for the Titterpig DSL's
.actor / .arc / block grammar, used for the file kinds the Go synthesist
does not merge (synthesist only merges .ttrpg).

Tokenizer is lifted from the canonical ttrpg_validator.py
(~/Working/Titterpig DSL/titterpig-dsl/ttrpg_validator.py) — same token
kinds (STR/HASH/CARET/INT/BOOL/ID/braces/brackets/comma), same comment
and hash-id disambiguation rule (a '#' is a hash id only when immediately
followed by an alnum char; otherwise it opens a line comment).

On top of that stream this file runs one generic recursive-descent parser
that turns *any* well-formed block (EXTENSION/ARC bodies, PROPERTIES,
FEATURES, PROFILES, LOCATION, SCENE, CHECKS, CLUES, OBJECTIVES,
RESOLUTIONS, CAST, FLOW/PHASE, ...) into one shape:

    {'form': 'entity', 'hash': str|None, 'name': str, 'body': [stmt, ...]}
    {'form': 'block',  'keyword': str, 'name': str|None, 'hash': str|None, 'body': [stmt, ...]}
    {'form': 'list',   'keyword': str, 'name': str|None, 'items': [str, ...]}
    {'form': 'value',  'keyword': str, 'name': str|None, 'value': str}
    {'form': 'prop',   'name': str, 'type': str, 'value': str|list}
    {'form': 'ref',    'keyword': str, 'name': str}
    {'form': 'flag',   'keyword': str}

It does not know what a SCENE or a PROPERTIES block *means* — callers walk
the generic tree and pull out what they need. This keeps one parser
serving three quite different file grammars instead of three bespoke ones.
"""
from dataclasses import dataclass


@dataclass
class Tok:
    kind: str
    val: str
    line: int


def tokenize(text):
    toks = []
    i, n, line = 0, len(text), 1
    while i < n:
        c = text[i]
        if c == '\n':
            line += 1; i += 1; continue
        if c in ' \t\r':
            i += 1; continue
        if c == '/' and i + 1 < n and text[i + 1] == '/':
            while i < n and text[i] != '\n':
                i += 1
            continue
        if c == '#':
            if i + 1 >= n or not text[i + 1].isalnum():
                while i < n and text[i] != '\n':
                    i += 1
                continue
            j = i + 1
            while j < n and (text[j].isalnum() or text[j] == '_'):
                j += 1
            toks.append(Tok('HASH', text[i:j], line)); i = j; continue
        if c == '^' and i + 1 < n and text[i + 1] == '"':
            j, start = i + 2, line
            while j < n and text[j] != '"':
                if text[j] == '\n':
                    line += 1
                j += 1
            toks.append(Tok('CARET', text[i + 2:j], start)); i = j + 1; continue
        if c == '"':
            if text[i:i + 3] == '"""':
                j = text.find('"""', i + 3)
                toks.append(Tok('STR', text[i + 3:j], line))
                line += text[i:j + 3].count('\n'); i = j + 3; continue
            j, start = i + 1, line
            while j < n and text[j] != '"':
                if text[j] == '\\' and j + 1 < n:
                    j += 2; continue
                if text[j] == '\n':
                    line += 1
                j += 1
            raw = text[i + 1:j]
            toks.append(Tok('STR', raw.replace('\\"', '"').replace('\\n', '\n'), start))
            i = j + 1; continue
        simple = {'{': 'LBRACE', '}': 'RBRACE', '[': 'LBRACK', ']': 'RBRACK', ',': 'COMMA', ':': 'COLON'}
        if c in simple:
            toks.append(Tok(simple[c], c, line)); i += 1; continue
        if c.isdigit() or (c == '-' and i + 1 < n and text[i + 1].isdigit()):
            j = i + 1
            while j < n and text[j].isdigit():
                j += 1
            toks.append(Tok('INT', text[i:j], line)); i = j; continue
        if c.isalpha() or c == '_':
            j = i + 1
            while j < n and (text[j].isalnum() or text[j] == '_'):
                j += 1
            w = text[i:j]
            toks.append(Tok('BOOL' if w in ('true', 'false') else 'ID', w, line)); i = j; continue
        i += 1
    return toks


PRIMITIVE_TYPES = ('STRING', 'INTEGER', 'BOOLEAN', 'TEXT')


class Parser:
    def __init__(self, toks):
        self.t = toks
        self.n = len(toks)

    def at(self, i):
        return self.t[i] if i < self.n else Tok('EOF', '', -1)

    def parse_body(self, i):
        """Parse statements until an RBRACE (not consumed) or EOF."""
        body = []
        while i < self.n and self.t[i].kind != 'RBRACE':
            stmt, i = self.parse_stmt(i)
            body.append(stmt)
        return body, i

    def parse_stmt(self, i):
        t = self.at(i)

        # entity: #hash ^"Name" DEF { ... }   OR   ^"Name" DEF { ... }
        h = None
        j = i
        if self.at(j).kind == 'HASH':
            h = self.at(j).val; j += 1
        if self.at(j).kind == 'CARET' and self.at(j + 1).kind == 'ID' and self.at(j + 1).val == 'DEF':
            name = self.at(j).val
            j += 2
            assert self.at(j).kind == 'LBRACE', f"expected {{ after DEF at line {self.at(j).line}"
            j += 1
            body, j = self.parse_body(j)
            assert self.at(j).kind == 'RBRACE'
            j += 1
            return {'form': 'entity', 'hash': h, 'name': name, 'body': body}, j

        # property: ^"Name" TYPE ...
        if t.kind == 'CARET':
            name = t.val
            k = i + 1
            kt = self.at(k)
            if kt.kind == 'ID' and kt.val in PRIMITIVE_TYPES:
                typ = kt.val
                vt = self.at(k + 1)
                return {'form': 'prop', 'name': name, 'type': typ, 'value': vt.val}, k + 2
            if kt.kind == 'ID' and kt.val == 'DEF':
                assert self.at(k + 1).kind == 'LBRACE'
                body, k2 = self.parse_body(k + 2)
                assert self.at(k2).kind == 'RBRACE'
                return {'form': 'prop', 'name': name, 'type': 'DEF', 'value': body}, k2 + 1
            if kt.kind == 'ID' and kt.val == 'LIST':
                k2 = k + 1
                if self.at(k2).kind == 'ID' and self.at(k2).val == 'OF':
                    k2 += 1
                if self.at(k2).kind == 'ID':
                    k2 += 1  # element type name (STRING etc)
                assert self.at(k2).kind == 'LBRACK'
                k2 += 1
                items = []
                while self.at(k2).kind != 'RBRACK':
                    if self.at(k2).kind == 'COMMA':
                        k2 += 1; continue
                    items.append(self.at(k2).val); k2 += 1
                return {'form': 'prop', 'name': name, 'type': 'LIST', 'value': items}, k2 + 1
            if kt.kind == 'ID' and kt.val == 'ENUM':
                k2 = k + 1
                items = []
                if self.at(k2).kind == 'LBRACK':
                    k2 += 1
                    while self.at(k2).kind != 'RBRACK':
                        if self.at(k2).kind == 'COMMA':
                            k2 += 1; continue
                        items.append(self.at(k2).val); k2 += 1
                    k2 += 1
                return {'form': 'prop', 'name': name, 'type': 'ENUM', 'value': items}, k2
            # bare caret ref (not followed by a type keyword)
            return {'form': 'ref', 'keyword': None, 'name': name}, k

        # FROM "Extension" INCLUDE [ #h, #h, ... ]  (CAST block only)
        if t.kind == 'ID' and t.val == 'FROM' and self.at(i + 1).kind == 'STR' \
                and self.at(i + 2).kind == 'ID' and self.at(i + 2).val == 'INCLUDE':
            src = self.at(i + 1).val
            k = i + 3
            assert self.at(k).kind == 'LBRACK'
            k += 1
            items = []
            while self.at(k).kind != 'RBRACK':
                if self.at(k).kind == 'COMMA':
                    k += 1; continue
                items.append(self.at(k).val); k += 1
            return {'form': 'block', 'keyword': 'FROM', 'name': src, 'hash': None,
                    'extends': None, 'body': [{'form': 'list', 'keyword': 'INCLUDE', 'name': None, 'items': items}]}, k + 1

        # keyword-led statement
        if t.kind == 'ID':
            keyword = t.val
            k = i + 1
            name = None
            hashid = None
            extends = None
            if self.at(k).kind == 'CARET':
                name = self.at(k).val; k += 1
            elif self.at(k).kind == 'STR' and (self.at(k + 1).kind == 'LBRACE' or
                                                (self.at(k + 1).kind == 'ID' and self.at(k + 1).val == 'EXTENDS')):
                # file-header form: EXTENSION "Name" [EXTENDS "Parent"] { ... }  or  ARC "Name" { ... }
                name = self.at(k).val; k += 1
                if self.at(k).kind == 'ID' and self.at(k).val == 'EXTENDS':
                    k += 1
                    if self.at(k).kind == 'STR':
                        extends = self.at(k).val; k += 1
            if self.at(k).kind == 'HASH':
                hashid = self.at(k).val; k += 1
            nx = self.at(k)
            if nx.kind == 'LBRACE':
                body, k2 = self.parse_body(k + 1)
                assert self.at(k2).kind == 'RBRACE'
                return {'form': 'block', 'keyword': keyword, 'name': name, 'hash': hashid, 'extends': extends, 'body': body}, k2 + 1
            if nx.kind == 'LBRACK':
                k2 = k + 1
                items = []
                while self.at(k2).kind != 'RBRACK':
                    if self.at(k2).kind == 'COMMA':
                        k2 += 1; continue
                    items.append(self.at(k2).val); k2 += 1
                return {'form': 'list', 'keyword': keyword, 'name': name, 'items': items}, k2 + 1
            if nx.kind in ('STR', 'INT', 'BOOL'):
                return {'form': 'value', 'keyword': keyword, 'name': name, 'value': nx.val}, k + 1
            if name is not None or hashid is not None:
                return {'form': 'ref', 'keyword': keyword, 'name': name, 'hash': hashid}, k
            return {'form': 'flag', 'keyword': keyword}, k

        # bare string statement (e.g. THEMES { "str" "str" ... })
        if t.kind == 'STR':
            return {'form': 'bare_str', 'value': t.val}, i + 1

        # anything unrecognized: skip one token to make forward progress
        return {'form': 'skip', 'tok': t.kind}, i + 1


def parse_file(path):
    text = open(path, encoding='utf-8').read()
    toks = tokenize(text)
    p = Parser(toks)
    body, i = p.parse_body(0)
    if i != len(toks):
        raise ValueError(f"{path}: {len(toks) - i} tokens left over after parse (stopped at {toks[i].kind} {toks[i].val!r} line {toks[i].line})")
    return body


# ── small tree helpers for callers ──────────────────────────────────────

def blocks_by_keyword(body, keyword):
    return [s for s in body if s.get('form') == 'block' and s.get('keyword') == keyword]


def values_by_keyword(body, keyword):
    return [s['value'] for s in body if s.get('form') == 'value' and s.get('keyword') == keyword]


def value(body, keyword, default=None):
    v = values_by_keyword(body, keyword)
    return v[0] if v else default


def entities(body):
    return [s for s in body if s.get('form') == 'entity']


def props_dict(body):
    """Flatten a PROPERTIES-style body (list of 'prop' stmts) into a plain dict."""
    out = {}
    for s in body:
        if s.get('form') != 'prop':
            continue
        if s['type'] == 'DEF':
            out[s['name']] = props_dict(s['value'])
        else:
            out[s['name']] = s['value']
    return out


if __name__ == '__main__':
    import sys, json
    for f in sys.argv[1:]:
        tree = parse_file(f)
        print(f, '->', len(tree), 'top-level statements')
