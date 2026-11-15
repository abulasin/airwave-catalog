"""Lists stations whose place is a region of a different country than the one they are filed under.
Report only: nothing is changed. Matches only region names that belong to a single country."""
import json, re, sys, unicodedata
from collections import Counter, defaultdict

def norm(s):
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()
    s = re.sub(r'\b(province|region|state|oblast|county|department|governorate|prefecture|of|the)\b', ' ', s)
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()

regions = json.load(open('tools/regions.json'))
owner = defaultdict(set)
for cc, info in regions.items():
    for code, name, alts in info['r']:
        for n in [name] + [a for a in alts if len(a) >= 5 and not a.isupper()]:
            k = norm(n)
            if len(k) >= 5:
                owner[k].add(cc)
mine = {cc: {norm(n) for _, name, alts in info['r'] for n in [name] + alts} for cc, info in regions.items()}

d = json.load(open('stations.json'))
cols = d['columns']
found = []
for r in d['stations']:
    s = dict(zip(cols, r))
    state, cc = (s.get('state') or '').strip(), (s.get('countryCode') or '').upper()
    if not state or not cc:
        continue
    parts = [p for p in re.split(r'[,/;|]', state) if p.strip()]
    for k in dict.fromkeys([norm(state)] + [norm(p) for p in parts]):
        if not k or k in mine.get(cc, set()):
            continue
        ccs = owner.get(k)
        if ccs and len(ccs) == 1 and cc not in ccs:
            found.append((s['name'], cc, state, next(iter(ccs)), s.get('clicks') or 0))
            break

print(f'CHECKED {len(d["stations"])} stations; {len(found)} look filed under the wrong country')
print('BY_PAIR', json.dumps(Counter(f'{a}->{b}' for _, a, _, b, _ in found).most_common(40)))
print('LIST_START')
for name, cc, state, real, clicks in sorted(found, key=lambda f: -f[4])[:400]:
    print(json.dumps({'n': name, 'filed': cc, 'place': state, 'real': real, 'clicks': clicks}, ensure_ascii=False))
print('LIST_END')
