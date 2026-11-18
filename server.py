"""Kingdom Inc Save Editor local server (loopback only)."""
import argparse
import base64
import glob
import gzip
import io
import json
import mimetypes
import os
import re
import shutil
import threading
import time
import urllib.request
import webbrowser
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
GAME_ROOT = ROOT.parent.parent
BUNDLED_CATALOG = ROOT / 'assets' / 'catalog.json'
BUNDLED_SPRITES = ROOT / 'assets' / 'sprites'
BUNDLED_FONTS = ROOT / 'assets' / 'fonts'
CATALOG_PATH = GAME_ROOT / '_Tools' / 'KingdomStudio' / 'game-catalog.json'
SRC_1014 = GAME_ROOT / '_SrcExtraction' / 'Extractions' / '1.0.14' / 'Source'
SPRITE_1014 = GAME_ROOT / '_SrcExtraction' / 'Extractions' / '1.0.14' / 'Exports' / 'Sprite'
UIDESIGNER_NATIVE = GAME_ROOT / '_Tools' / 'UIDesigner' / 'assets' / 'native'
LOC_1014 = GAME_ROOT / '_SrcExtraction' / 'Extractions' / '1.0.14' / 'Exports' / 'TextAsset' / 'resources.assets' / '22__en-US.txt'
FONTS_ROOT = BUNDLED_FONTS if BUNDLED_FONTS.is_dir() else (GAME_ROOT / '_Tools' / 'UIDesigner' / 'assets' / 'fonts')


def get_default_saves_dir() -> Path:
    candidates = [
        Path.home() / 'AppData' / 'LocalLow' / 'Leaping Turtle' / 'KingdomInc' / 'Saves',
        Path(os.environ.get('USERPROFILE', str(Path.home()))) / 'AppData' / 'LocalLow' / 'Leaping Turtle' / 'KingdomInc' / 'Saves',
    ]
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]


SAVES_DIR = get_default_saves_dir()

# FNV-1a 64-bit matching Assets.Source.Util.SeedGenerator
FNV_PRIME = 1099511628211
FNV_OFFSET = 14695981039346656037
MASK64 = (1 << 64) - 1
SEP_BYTES = bytes([251, 45, 49])


def compute_secret(data: dict) -> str:
    h = FNV_OFFSET

    def add_bytes(b: bytes):
        nonlocal h
        for x in b:
            h = ((h ^ x) * FNV_PRIME) & MASK64

    def add_str(s):
        if s is None:
            s = 'null'
        add_bytes(s.encode('ascii', errors='replace'))
        add_bytes(SEP_BYTES)

    def add_val(v):
        if isinstance(v, dict):
            for k in sorted(v.keys()):
                add_str('K')
                add_str(k)
                add_str('V')
                add_val(v[k])
        elif isinstance(v, list):
            for item in v:
                add_val(item)
        elif v is None:
            add_str(None)
        elif isinstance(v, bool):
            add_str('true' if v else 'false')
        elif isinstance(v, float) and v.is_integer():
            add_str(str(int(v)))
        else:
            add_str(str(v))

    payload = {'Version': data.get('Version'), 'Player': data.get('Player')}
    add_val(payload)
    return str(h)


def build_sprite_index() -> dict[str, Path]:
    index: dict[str, Path] = {}
    roots = [BUNDLED_SPRITES, SPRITE_1014, UIDESIGNER_NATIVE]
    for r in roots:
        if not r.exists():
            continue
        for p in r.rglob('*.png'):
            stem = p.stem
            # Strip Unity export numeric prefix like "100__Icons3_49"
            name = re.sub(r'^\d+__', '', stem)
            if name not in index:
                index[name] = p
            if stem not in index:
                index[stem] = p
    return index


SPRITE_INDEX = build_sprite_index()


def load_localization() -> dict[str, str]:
    loc: dict[str, str] = {}
    if not LOC_1014.exists():
        return loc
    text = LOC_1014.read_text(encoding='utf-8', errors='ignore')
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(';'):
            continue
        if '=' in line:
            k, v = line.split('=', 1)
            k = k.strip()
            v = v.strip().replace('\\n', '\n')
            loc[k] = v
    return loc


def resolve_loc(s: str, loc: dict[str, str]) -> str:
    if not s:
        return ''
    if s.startswith('@'):
        key = s[1:]
        return loc.get(key, s)
    return s


def extract_catalog() -> dict:
    loc = load_localization()
    raw_catalog = {}
    if CATALOG_PATH.exists():
        raw_catalog = json.loads(CATALOG_PATH.read_text(encoding='utf-8'))

    techs = []
    elements = []
    items = []
    recipes = []
    currencies = []
    adventurers = []
    quests = []
    dungeons_cat = []

    for e in raw_catalog.get('Entries', []):
        kind = e.get('Kind')
        item_copy = dict(e)
        item_copy['Name'] = resolve_loc(e.get('Name', ''), loc)
        item_copy['Description'] = resolve_loc(e.get('Description', ''), loc)
        if kind == 0:
            techs.append(item_copy)
        elif kind == 1:
            elements.append(item_copy)
        elif kind == 2:
            items.append(item_copy)
        elif kind == 3:
            recipes.append(item_copy)
        elif kind == 4:
            currencies.append(item_copy)
        elif kind == 5:
            adventurers.append(item_copy)
        elif kind == 6:
            quests.append(item_copy)
        elif kind == 7:
            dungeons_cat.append(item_copy)

    # Filter out any modded / DevMode entries from game-catalog.json using 1.0.14 C# source
    tech_dir = SRC_1014 / 'Assets.Source.Player.Tech'
    if tech_dir.is_dir():
        tech_txt = '\n'.join(f.read_text(encoding='utf-8', errors='ignore') for f in sorted(tech_dir.glob('*.cs')))
        vanilla_tech_ids = set(re.findall(r'new TechNode\("([^"]+)"\)', tech_txt))
        vanilla_tech_ids.discard('dev_item_spawner')
        for m in re.finditer(r'AddDefaultUpgrades\("([^"]+)"', tech_txt):
            s = re.sub(r'(?<!^)(?=[A-Z])', '_', m.group(1)).lower()
            for suf in ('_automation', '_automation_2', '_automation_3', '_productivity', '_quality'):
                vanilla_tech_ids.add(s + suf)
        for helper_name, suf in (
            ('UpgradeWorker', '_automation'),
            ('UpgradeSlot2', '_automation_2'),
            ('UpgradeSlot3', '_automation_3'),
            ('UpgradeQuality', '_quality'),
            ('UpgradeProductivity', '_productivity'),
            ('UpgradeCoffers', '_coffers'),
        ):
            for m in re.finditer(rf'{helper_name}\("([^"]+)"', tech_txt):
                s = re.sub(r'(?<!^)(?=[A-Z])', '_', m.group(1)).lower()
                vanilla_tech_ids.add(s + suf)
        techs = [t for t in techs if t.get('Id') in vanilla_tech_ids]

    el_dir = SRC_1014 / 'Assets.Source.Flow.Elements'
    if el_dir.is_dir():
        vanilla_el_ids = {f.stem for f in el_dir.glob('*.cs')} - {'RecipeElement', 'ResourceElement', 'InnSlot', 'TrainingGroundsSlot'}
        elements = [e for e in elements if e.get('Id') in vanilla_el_ids]

    # Enrich from 1.0.14 C# source
    prestige_nodes = []
    pnode_path = SRC_1014 / 'Assets.Source.Player' / 'PrestigeNode.cs'
    if pnode_path.exists():
        ptxt = pnode_path.read_text(encoding='utf-8', errors='ignore')
        for m in re.finditer(
            r'new PrestigeNode\("([^"]+)"\)\s*\{([^}]+)\}',
            ptxt,
            re.S,
        ):
            pid = m.group(1)
            body = m.group(2)
            ic = re.search(r'IconName\s*=\s*"([^"]+)"', body)
            calc = re.search(r'CalcValue\s*=\s*\(int points\)\s*=>\s*([^\n;]+)', body)
            name = loc.get(f'prestige_{pid}', pid.replace('_', ' ').title())
            desc_tpl = loc.get(f'prestige_{pid}_desc', '{0}')
            prestige_nodes.append({
                'id': pid,
                'name': name,
                'descTemplate': desc_tpl,
                'icon': ic.group(1) if ic else 'Icons_4',
                'formula': calc.group(1).strip() if calc else '',
            })

    # Wars
    wars = []
    wars_dir = SRC_1014 / 'Assets.Source.Adventure.Wars'
    if wars_dir.exists():
        war_id_map = {'East': 'eastern', 'Forest': 'forest', 'North': 'north', 'Yensburg': 'yensburg'}
        for f in sorted(wars_dir.glob('*.cs')):
            txt = f.read_text(encoding='utf-8', errors='ignore')
            cls_name = f.stem
            wid = war_id_map.get(cls_name, cls_name.lower())
            base_m = re.search(r':\s*base\("([^"]+)"\)', txt)
            if base_m:
                wid = base_m.group(1)
            dn = re.search(r'DisplayName\s*=\s*"([^"]+)"', txt)
            desc = re.search(r'Description\s*=\s*"([^"]+)"', txt)
            ic = re.search(r'IconName\s*=\s*"([^"]+)"', txt)
            eic = re.search(r'EnemyIconName\s*=\s*"([^"]+)"', txt)
            stage_names = [resolve_loc(s, loc) for s in re.findall(r'DisplayName\s*=\s*"([^"]+)"', txt)[1:]]
            stage_count = len(re.findall(r'new WarStage', txt))
            wars.append({
                'id': wid,
                'name': resolve_loc(dn.group(1), loc) if dn else wid.title(),
                'description': resolve_loc(desc.group(1), loc) if desc else '',
                'icon': ic.group(1) if ic else 'Icons_71',
                'enemyIcon': eic.group(1) if eic else '',
                'stageCount': stage_count or 5,
                'stageNames': stage_names,
            })

    # Dungeons stage counts & details
    dungeons = []
    dng_dir = SRC_1014 / 'Assets.Source.Adventure.Dungeons'
    dng_map = {}
    for d in dungeons_cat:
        dng_map[d['Id']] = d
    if dng_dir.exists():
        for f in sorted(dng_dir.glob('*.cs')):
            txt = f.read_text(encoding='utf-8', errors='ignore')
            base_m = re.search(r':\s*base\("([^"]+)"\)', txt)
            if not base_m:
                continue
            did = base_m.group(1)
            cat = dng_map.get(did, {})
            stage_pairs = len(re.findall(r'AddStage\(', txt))
            stages_total = stage_pairs * 2 if stage_pairs else 8
            dn = re.search(r'DisplayName\s*=\s*"([^"]+)"', txt)
            ic = re.search(r'IconName\s*=\s*"([^"]+)"', txt)
            dungeons.append({
                'id': did,
                'name': cat.get('Name') or (resolve_loc(dn.group(1), loc) if dn else did.title()),
                'description': cat.get('Description', ''),
                'icon': cat.get('Icon') or (ic.group(1) if ic else 'Icons_178'),
                'stageCount': stages_total,
            })
    if not dungeons:
        for d in dungeons_cat:
            dungeons.append({
                'id': d['Id'],
                'name': d['Name'],
                'description': d.get('Description', ''),
                'icon': d.get('Icon', 'Icons_178'),
                'stageCount': 8,
            })

    # FlowUpgrades
    flow_upgrades = []
    upg_dir = SRC_1014 / 'Assets.Source.Flow.Upgrades'
    if upg_dir.exists():
        for f in sorted(upg_dir.glob('*.cs')):
            uid = f.stem
            txt = f.read_text(encoding='utf-8', errors='ignore')
            ic = re.search(r'IconName\s*=>\s*"([^"]+)"', txt)
            lb = re.search(r'DisplayName\s*=>\s*"([^"]+)"', txt) or re.search(r'Label\s*=>\s*"([^"]+)"', txt)
            desc = re.search(r'Description\s*=>\s*"([^"]+)"', txt)
            label_key = lb.group(1) if lb else f'@upgrade_{uid.lower()}'
            name = resolve_loc(label_key, loc)
            if name.startswith('@'):
                name = re.sub(r'(?<!^)(?=[A-Z0-9])', ' ', uid)
            flow_upgrades.append({
                'id': uid,
                'name': name,
                'description': resolve_loc(desc.group(1), loc) if desc else '',
                'icon': ic.group(1) if ic else 'Icons_17',
            })

    # ItemEnhancements
    enhancements = []
    enh_dir = SRC_1014 / 'Assets.Source.Items.Enhancements'
    if enh_dir.exists():
        for f in sorted(enh_dir.glob('*.cs')):
            txt = f.read_text(encoding='utf-8', errors='ignore')
            for m in re.finditer(r'new ItemEnhancement\("([^"]+)"\)\s*\{(.*?)\n\t\t\}', txt, re.S):
                eid = m.group(1)
                body = m.group(2)
                ic = re.search(r'IconName\s*=\s*"([^"]+)"', body)
                tp = re.search(r'Type\s*=\s*EnhancementType\.(\w+)', body)
                aq = re.search(r'AddQuality\s*=\s*([0-9.]+)f?', body)
                tr = re.search(r'EquipTrait\s*=\s*AdventurerTrait\.(\w+)', body)
                stats = {}
                for sm in re.finditer(r'EquipStat\.(\w+)\s*,\s*(-?\d+)', body):
                    stats[sm.group(1)] = int(sm.group(2))
                name = loc.get(f'enh_{eid}', loc.get(eid, eid.replace('_', ' ').title()))
                enhancements.append({
                    'id': eid,
                    'name': name,
                    'type': tp.group(1) if tp else 'Enchant',
                    'icon': ic.group(1) if ic else 'Icons_206',
                    'addQuality': float(aq.group(1)) if aq else 0.0,
                    'equipTrait': tr.group(1) if tr else None,
                    'stats': stats,
                })

    # Forest, Farm, Mine/Resource items + Equipment details
    forest_items = []
    farm_items = []
    resource_items = []
    item_meta = {}
    impl_dir = SRC_1014 / 'Assets.Source.Items.Impl'
    if impl_dir.exists():
        for f in sorted(impl_dir.glob('*.cs')):
            txt = f.read_text(encoding='utf-8', errors='ignore')
            for m in re.finditer(r'new (\w+ItemType)\("([^"]+)"\)\s*\{(.*?)\n\t\t\}', txt, re.S):
                cls, iid, body = m.group(1), m.group(2), m.group(3)
                slot_m = re.search(r'Slot\s*=\s*EquipmentSlot\.(\w+)', body)
                wtype_m = re.search(r'WeaponType\s*=\s*WeaponType\.(\w+)', body)
                atype_m = re.search(r'ArmorType\s*=\s*ArmorType\.(\w+)', body)
                arch_m = re.search(r'Archetype\s*=\s*AdventurerArchetype\.(\w+)', body)
                worker_m = re.search(r'WorkerType\s*=\s*ForestWorker\.(\w+)', body)
                yield_m = re.search(r'PlotYield\s*=\s*([0-9.]+)f?', body)
                stats = {}
                for sm in re.finditer(r'EquipStat\.(\w+)\s*,\s*(-?\d+)', body):
                    stats[sm.group(1)] = int(sm.group(2))
                item_meta[iid] = {
                    'itemClass': cls,
                    'slot': slot_m.group(1) if slot_m else None,
                    'weaponType': wtype_m.group(1) if wtype_m else None,
                    'armorType': atype_m.group(1) if atype_m else None,
                    'archetype': arch_m.group(1) if arch_m else None,
                    'forestWorker': worker_m.group(1) if worker_m else None,
                    'plotYield': float(yield_m.group(1)) if yield_m else None,
                    'baseStats': stats,
                }
                if cls == 'ForestItemType':
                    forest_items.append(iid)
                elif cls == 'FarmItemType':
                    farm_items.append(iid)
                elif cls in ('ResourceItemType', 'MineItemType'):
                    resource_items.append(iid)

    # Merge item_meta into items & adventurers
    for lst in (items, adventurers):
        for it in lst:
            meta = item_meta.get(it['Id'])
            if meta:
                it.update(meta)

    # Extract exact Unity prefab dimensions (width, height) from sharedassets2.assets
    element_sizes = {}
    sa2 = GAME_ROOT / '_SrcExtraction' / 'Extractions' / '1.0.14' / 'Assets' / 'sharedassets2.assets'
    god = sa2 / 'GameObject'
    rtd = sa2 / 'RectTransform'
    if god.is_dir() and rtd.is_dir():
        rt_map = {}
        for rf in rtd.iterdir():
            if rf.suffix == '.json' and '__' in rf.name:
                rt_map[rf.name.split('__', 1)[0]] = rf
        for gf in god.iterdir():
            if gf.suffix != '.json' or '__' not in gf.name:
                continue
            try:
                go = json.loads(gf.read_text(encoding='utf-8', errors='ignore'))
                for c in go.get('m_Component', []):
                    pid = str(c.get('component', {}).get('m_PathID', ''))
                    if pid in rt_map:
                        rt = json.loads(rt_map[pid].read_text(encoding='utf-8', errors='ignore'))
                        piv = rt.get('m_Pivot', {})
                        sz = rt.get('m_SizeDelta', {})
                        if piv.get('x') == 0.0 and piv.get('y') == 1.0 and sz.get('x', 0) >= 64 and sz.get('y', 0) >= 64:
                            el_name = gf.name.split('__', 1)[1][:-5]
                            element_sizes[el_name] = [int(sz['x']), int(sz['y'])]
                        break
            except Exception:
                pass

    return {
        'gameVersion': raw_catalog.get('GameVersion', 'Release v1.0.14'),
        'currencies': currencies,
        'techs': techs,
        'elements': elements,
        'elementSizes': element_sizes,
        'items': items,
        'adventurers': adventurers,
        'recipes': recipes,
        'quests': quests,
        'dungeons': dungeons,
        'wars': wars,
        'prestigeNodes': prestige_nodes,
        'flowUpgrades': flow_upgrades,
        'enhancements': enhancements,
        'forestItems': forest_items,
        'farmItems': farm_items,
        'resourceItems': resource_items,
        'stats': raw_catalog.get('Stats', ['Health', 'Armor', 'Strength', 'Dexterity', 'Magic', 'Wisdom', 'Energy', 'CombatPower']),
        'traits': raw_catalog.get('Traits', []),
        'recipeTags': raw_catalog.get('RecipeTags', []),
        'icons': sorted(set(raw_catalog.get('Icons', [])) | set(SPRITE_INDEX.keys())),
        'enums': {
            'EnhancementType': ['Engrave', 'Enchant', 'Blessing'],
            'EquipmentSlot': ['Chest', 'Head', 'MainHand', 'OffHand', 'Amulet', 'Ring', 'Trinket', 'Food', 'Potion', 'Scroll'],
            'AppraiserStat': [
                'Quality', 'MaxHealth', 'MaxEnergy', 'Armor', 'Strength', 'Dexterity',
                'Magic', 'Wisdom', 'Training', 'CurrentHealth', 'CurrentEnergy',
                'CombatPower', 'EnhancementCount', 'EquipmentCount'
            ],
            'AppraiserType': ['Equal', 'NotEqual', 'LessThan', 'LessThanOrEqual', 'GreaterThan', 'GreaterThanOrEqual'],
            'ForestWorker': ['Unassigned', 'Forager', 'Logger', 'Hunter'],
            'DecoStyles': [
                {'index': 0, 'name': 'Slate', 'color': '#4b5563'},
                {'index': 1, 'name': 'Crimson', 'color': '#b91c1c'},
                {'index': 2, 'name': 'Emerald', 'color': '#15803d'},
                {'index': 3, 'name': 'Cobalt', 'color': '#1d4ed8'},
                {'index': 4, 'name': 'Amber', 'color': '#b45309'},
                {'index': 5, 'name': 'Violet', 'color': '#6d28d9'},
                {'index': 6, 'name': 'Teal', 'color': '#0f766e'},
                {'index': 7, 'name': 'Gold', 'color': '#ca8a04'},
            ],
            'ArmoryChannelColors': [
                '#ff4545', '#45ff45', '#4545ff', '#ffeb45',
                '#8c28f2', '#55c4ce', '#9e9e9e', '#cb8532'
            ],
        },
        'spritesAvailable': len(SPRITE_INDEX),
    }


def load_or_extract_catalog() -> dict:
    if BUNDLED_CATALOG.is_file() and not SRC_1014.is_dir():
        data = json.loads(BUNDLED_CATALOG.read_text(encoding='utf-8'))
        data['spritesAvailable'] = len(SPRITE_INDEX)
        return data
    if CATALOG_PATH.is_file() or SRC_1014.is_dir():
        return extract_catalog()
    if BUNDLED_CATALOG.is_file():
        data = json.loads(BUNDLED_CATALOG.read_text(encoding='utf-8'))
        data['spritesAvailable'] = len(SPRITE_INDEX)
        return data
    return {}


KNOWN_MOD_DEFS = {
    'AudioManager': {
        'modId': 'urakka.kingdominc.audiomanager',
        'name': 'Audio Manager',
    },
    'BalancedContainers': {
        'modId': 'urakka.kingdominc.balancedcontainers',
        'name': 'Balanced Containers',
        'decoKeys': ['urakka.balancedcontainers', 'urakka.productioncontainer'],
    },
    'BetterDeconstruct': {
        'modId': 'urakka.kingdominc.betterdeconstruct',
        'name': 'Better Deconstruct',
    },
    'BetterZoom': {
        'modId': 'urakka.kingdominc.betterzoom',
        'name': 'Better Zoom',
        'techs': ['urakka.kingdominc.betterzoom.unlock'],
    },
    'BottleneckHeatmap': {
        'modId': 'urakka.kingdominc.bottleneckheatmap',
        'name': 'Bottleneck Heatmap',
        'techs': ['urakka.kingdominc.bottleneckheatmap.unlock'],
    },
    'ContainerColors': {
        'modId': 'urakka.kingdominc.containercolors',
        'name': 'Container Colors',
        'techs': ['container_colors'],
        'decoKeys': ['urakka.containercolors'],
    },
    'DevSpawner': {
        'modId': 'urakka.kingdominc.devspawner',
        'name': 'Dev Spawner',
        'techs': ['urakka.kingdominc.devspawner.unlock'],
    },
    'Foundation': {
        'modId': 'urakka.kingdominc.foundation',
        'name': 'Foundation',
    },
    'GlobalLedger': {
        'modId': 'urakka.kingdominc.globalledger',
        'name': 'Global Ledger',
        'techs': ['global_ledger'],
    },
    'GlobalLedgerV2': {
        'modId': 'urakka.kingdominc.globalledgerv2',
        'name': 'Global Ledger V2',
        'techs': ['global_ledger'],
    },
    'HDSnapshot': {
        'modId': 'urakka.kingdominc.hdsnapshot',
        'name': 'HD Snapshot',
    },
    'HotkeyCustomizer': {
        'modId': 'urakka.kingdominc.hotkeycustomizer',
        'name': 'Hotkey Customizer',
        # Note: v1.5.2+ no longer registers urakka.kingdominc.hotkeycustomizer.unlock
    },
    'LedgerMod': {
        'modId': 'urakka.kingdominc.ledgermod',
        'name': 'Ledger',
        'techs': ['ledger_mod'],
        'elements': {'Ledger': [384, 192]},
        'elementKeys': ['LedgerPairs', 'LedgerPeriod'],
    },
    'LeylineConduits': {
        'modId': 'urakka.kingdominc.leylineconduits',
        'name': 'Leyline Conduits',
        'techs': ['leyline_conduits'],
        'elements': {'LeylineConduit': [64, 64]},
        'elementKeys': ['LeylineMode', 'LeylineChannel', 'LeylineIcon', 'LeylineManualIcon'],
    },
    'LeylineLogistics': {
        'modId': 'urakka.kingdominc.leylinelogistics',
        'name': 'Leyline Logistics',
        'techs': ['leyline_dimension_node'],
        'elements': {
            'LeylineNode': [256, 320],
            'LeylineInputBank': [128, 320],
            'LeylineOutputBank': [128, 320],
            'leyline_and': [128, 128],
            'leyline_or': [128, 128],
            'leyline_xor': [128, 128],
            'leyline_not': [128, 128],
            'leyline_timer': [128, 128],
            'leyline_counter': [128, 128],
            'leyline_ifelse': [128, 128],
            'leyline_latch': [128, 128],
            'leyline_if': [128, 128],
            'leyline_else': [128, 128],
            'leyline_compare': [128, 128],
        },
        'elementKeys': [
            'DimName', 'NodeNum', 'LayoutVer', 'HasGeom', 'PopX', 'PopY', 'PopW', 'PopH',
            'Diagram', 'LogicWires', 'mode', 'latch', 'cntTarget', 'cntVal', 'tmrInt',
        ],
    },
    'PartyUp': {
        'modId': 'urakka.kingdominc.partynode',
        'name': 'Party-Up',
        'techs': ['party_node', 'party_node_auto_send'],
        'elements': {'Party': [192, 192]},
        'upgrades': ['PartyAutoSend'],
        'elementKeys': ['PartyRequirements', 'RecoveredMembers', 'AutoSend'],
    },
    'PathFinder': {
        'modId': 'urakka.kingdominc.pathfinder',
        'name': 'Path Finder',
        'techs': ['urakka.kingdominc.pathfinder.research'],
    },
    'PipeWrench': {
        'modId': 'urakka.kingdominc.pipewrench',
        'name': 'Pipe Wrench',
        'techs': ['urakka.kingdominc.pipewrench.unlock'],
    },
    'PortLayouts': {
        'modId': 'urakka.kingdominc.portlayouts',
        'name': 'Port Layouts',
        'techs': ['urakka.kingdominc.portlayouts.rotation'],
        'elementKeys': ['UrakkaPortLayout'],
    },
    'RightClickFix': {
        'modId': 'urakka.kingdominc.rightclickfix',
        'name': 'Right Click Fix',
    },
    'SharableBlueprints': {
        'modId': 'urakka.kingdominc.sharableblueprints',
        'name': 'Sharable Blueprints',
        'techs': ['urakka.kingdominc.sharableblueprints.unlock'],
    },
    'Snappy': {
        'modId': 'urakka.kingdominc.snappy',
        'name': 'Snappy',
        'techs': ['urakka.kingdominc.snappy.research'],
    },
    'Undo': {
        'modId': 'urakka.kingdominc.undo',
        'name': 'Undo',
    },
    'Unstacker': {
        'modId': 'urakka.kingdominc.unstacker',
        'name': 'Unstacker',
    },
}


def scan_installed_mods() -> dict:
    plugins_dir = GAME_ROOT / 'BepInEx' / 'plugins'
    mods_src_root = GAME_ROOT / '_Mods'
    plugins = []
    techs = {}
    elements = {}
    upgrades = {}
    deco_keys = {}
    element_keys = {}
    mod_ids = {}

    if not plugins_dir.is_dir():
        return {
            'pluginsDir': str(plugins_dir),
            'plugins': plugins,
            'techs': techs,
            'elements': elements,
            'upgrades': upgrades,
            'decoKeys': deco_keys,
            'elementKeys': element_keys,
            'modIds': mod_ids,
        }

    for dll in sorted(plugins_dir.rglob('*.dll')):
        if dll.name.endswith(('.vortex_backup', '.old', '.disabled')):
            continue
        folder = dll.parent.name if dll.parent != plugins_dir else dll.stem
        stem = dll.stem
        mod_json = dll.parent / 'mod.json'
        meta = {}
        if mod_json.is_file():
            try:
                meta = json.loads(mod_json.read_text(encoding='utf-8-sig'))
            except Exception:
                pass

        known = KNOWN_MOD_DEFS.get(stem) or KNOWN_MOD_DEFS.get(folder) or {}
        mod_id = known.get('modId') or meta.get('id') or stem
        mod_name = meta.get('name') or known.get('name') or stem
        version = meta.get('version') or ''

        plugins.append({
            'folder': folder,
            'dll': dll.name,
            'modId': mod_id,
            'name': mod_name,
            'version': version,
        })
        mod_ids[mod_id] = mod_name

        for tid in known.get('techs', []):
            techs[tid] = {'id': tid, 'modId': mod_id, 'modName': mod_name}
        for el_id, sz in (known.get('elements') or {}).items():
            elements[el_id] = {'id': el_id, 'modId': mod_id, 'modName': mod_name, 'size': sz}
        for upg_id in known.get('upgrades', []):
            upgrades[upg_id] = {'id': upg_id, 'modId': mod_id, 'modName': mod_name}
        for dk in known.get('decoKeys', []):
            deco_keys[dk] = {'key': dk, 'modId': mod_id, 'modName': mod_name}
        for ek in known.get('elementKeys', []):
            element_keys[ek] = {'key': ek, 'modId': mod_id, 'modName': mod_name}

        # Dynamic source scan if _Mods/<folder>/src exists (picks up any new definitions)
        src_dir = mods_src_root / folder / 'src'
        if src_dir.is_dir():
            cs_files = [
                f for f in src_dir.rglob('*.cs')
                if 'Verification' not in f.parts and 'Tests' not in f.parts and 'RuntimeProbe' not in f.name
            ]
            if cs_files:
                txt = '\n'.join(f.read_text(encoding='utf-8', errors='ignore') for f in cs_files)
                for m in re.finditer(r'new\s+TechNodeDefinition\(\s*"([^"]+)"', txt):
                    tid = m.group(1)
                    if ' ' not in tid and not tid.startswith(('foundation.', 'example.', 'other.', 'changed.')):
                        techs.setdefault(tid, {'id': tid, 'modId': mod_id, 'modName': mod_name})
                for m in re.finditer(r'new\s+(?:Framework)?WorkspaceNodeDefinition\(\s*"([^"]+)"', txt):
                    el_id = m.group(1)
                    if ' ' not in el_id and not el_id.startswith(('diagnostic.', 'urakka.foundation.')):
                        elements.setdefault(el_id, {'id': el_id, 'modId': mod_id, 'modName': mod_name, 'size': [192, 128]})
                for m in re.finditer(r'new\s+LeylineLogicSpec\(\s*"([^"]+)"', txt):
                    el_id = m.group(1)
                    elements.setdefault(el_id, {'id': el_id, 'modId': mod_id, 'modName': mod_name, 'size': [128, 128]})

    return {
        'pluginsDir': str(plugins_dir),
        'plugins': plugins,
        'techs': techs,
        'elements': elements,
        'upgrades': upgrades,
        'decoKeys': deco_keys,
        'elementKeys': element_keys,
        'modIds': mod_ids,
    }


CATALOG_CACHE = load_or_extract_catalog()


def read_save_file(path: Path) -> tuple[dict, str, int]:
    raw = path.read_bytes()
    raw_len = len(raw)
    if raw[:2] == b'\x1f\x8b':
        text = gzip.decompress(raw).decode('utf-8')
        fmt = 'compressed'
    else:
        text = raw.decode('utf-8')
        fmt = 'pretty' if '\n' in text[:300] else 'uncompressed'
    return json.loads(text), fmt, raw_len


def parse_save_bytes(raw: bytes) -> tuple[dict, str]:
    if raw[:2] == b'\x1f\x8b':
        text = gzip.decompress(raw).decode('utf-8')
        fmt = 'compressed'
    else:
        text = raw.decode('utf-8')
        fmt = 'pretty' if '\n' in text[:300] else 'uncompressed'
    return json.loads(text), fmt


def summarize_save(path: Path) -> dict:
    stat = path.stat()
    info = {
        'name': path.name,
        'path': str(path),
        'size': stat.st_size,
        'mtime': stat.st_mtime,
        'mtimeIso': datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M:%S'),
        'hasBak': path.with_name(path.name + '.bak').exists(),
        'format': 'unknown',
        'version': '',
        'gameTime': 0,
        'ascensionCount': 0,
        'flowCount': 0,
        'techCount': 0,
        'gold': '0',
        'error': None,
    }
    try:
        data, fmt, _ = read_save_file(path)
        pl = data.get('Player') or {}
        info['format'] = fmt
        info['version'] = data.get('Version', '')
        info['gameTime'] = pl.get('GameTime', 0)
        info['ascensionCount'] = pl.get('AscensionCount', 0)
        info['nightmareCount'] = pl.get('NightmareCount', 0)
        info['flowCount'] = len(pl.get('Flows') or [])
        info['techCount'] = len(pl.get('Tech') or [])
        info['gold'] = str((pl.get('Currency') or {}).get('Gold', '0'))
    except Exception as ex:
        info['error'] = str(ex)
    return info


def backup_dir_for(target: Path) -> Path:
    d = target.parent / '.saveeditor_backups'
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_save_file(target: Path, data: dict, fmt: str = 'compressed', secret_mode: str = 'keep', create_backup: bool = True) -> dict:
    out_data = dict(data)
    if secret_mode == 'remove':
        out_data.pop('Secret', None)
    elif secret_mode == 'recompute':
        out_data['Secret'] = compute_secret(out_data)
    # else 'keep': leave Secret as-is

    if fmt == 'pretty':
        json_text = json.dumps(out_data, indent=2, ensure_ascii=False)
        out_bytes = json_text.encode('utf-8')
    elif fmt == 'uncompressed':
        json_text = json.dumps(out_data, separators=(',', ':'), ensure_ascii=False)
        out_bytes = json_text.encode('utf-8')
    else:
        json_text = json.dumps(out_data, separators=(',', ':'), ensure_ascii=False)
        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode='wb') as gz:
            gz.write(json_text.encode('utf-8'))
        out_bytes = buf.getvalue()

    target.parent.mkdir(parents=True, exist_ok=True)
    backup_path = None
    if create_backup and target.exists():
        bak = target.with_name(target.name + '.bak')
        shutil.copy2(target, bak)
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        snap = backup_dir_for(target) / f'{target.stem}_{ts}{target.suffix}'
        shutil.copy2(target, snap)
        backup_path = str(snap)

    tmp = target.with_name(f'.{target.name}.{os.getpid()}.tmp')
    try:
        with open(tmp, 'wb') as f:
            f.write(out_bytes)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass

    return {
        'ok': True,
        'path': str(target),
        'bytesWritten': len(out_bytes),
        'jsonBytes': len(json_text.encode('utf-8')),
        'backupPath': backup_path,
    }


class SaveEditorHandler(SimpleHTTPRequestHandler):
    def send_json(self, status: int, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> dict:
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length) if length > 0 else b'{}'
        return json.loads(raw.decode('utf-8'))

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/health':
            return self.send_json(200, {
                'app': 'KingdomIncSaveEditor',
                'root': str(ROOT),
                'pid': os.getpid(),
                'savesDir': str(SAVES_DIR),
            })

        if path == '/api/catalog':
            payload = dict(CATALOG_CACHE)
            payload['installedMods'] = scan_installed_mods()
            return self.send_json(200, payload)

        if path == '/api/saves':
            qs = parse_qs(parsed.query)
            custom_dir = qs.get('dir', [None])[0]
            sdir = Path(custom_dir) if custom_dir else SAVES_DIR
            saves = []
            if sdir.exists():
                for entry in sorted(sdir.iterdir(), key=lambda p: p.stat().st_mtime if p.is_file() else 0, reverse=True):
                    if entry.is_file() and (entry.name.endswith('.save') or entry.name.endswith('.json')):
                        saves.append(summarize_save(entry))
            return self.send_json(200, {
                'savesDir': str(sdir),
                'exists': sdir.exists(),
                'saves': saves,
            })

        if path == '/api/backups':
            qs = parse_qs(parsed.query)
            target_path = qs.get('path', [None])[0]
            sdir = Path(target_path).parent if target_path else SAVES_DIR
            bdir = sdir / '.saveeditor_backups'
            backups = []
            if bdir.exists():
                for entry in sorted(bdir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
                    if entry.is_file():
                        st = entry.stat()
                        backups.append({
                            'name': entry.name,
                            'path': str(entry),
                            'size': st.st_size,
                            'mtimeIso': datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M:%S'),
                        })
            if target_path:
                bak = Path(target_path).with_name(Path(target_path).name + '.bak')
                if bak.exists():
                    st = bak.stat()
                    backups.insert(0, {
                        'name': bak.name + ' (Latest .bak)',
                        'path': str(bak),
                        'size': st.st_size,
                        'mtimeIso': datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M:%S'),
                    })
            return self.send_json(200, {'backups': backups})

        if path.startswith('/sprites/'):
            name = unquote(path[len('/sprites/'):])
            if name.endswith('.png'):
                name = name[:-4]
            sprite_path = SPRITE_INDEX.get(name)
            if sprite_path and sprite_path.exists():
                data = sprite_path.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'public, max-age=86400')
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_response(404)
            self.end_headers()
            return

        if path.startswith('/fonts/'):
            fname = unquote(path[len('/fonts/'):])
            fpath = (FONTS_ROOT / fname).resolve()
            if fpath.is_file() and fpath.parent == FONTS_ROOT.resolve():
                data = fpath.read_bytes()
                ctype = mimetypes.guess_type(str(fpath))[0] or 'application/octet-stream'
                self.send_response(200)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'public, max-age=86400')
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_response(404)
            self.end_headers()
            return

        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            body = self.read_json_body()
        except Exception as ex:
            return self.send_json(400, {'error': f'Invalid JSON request: {ex}'})

        try:
            if path == '/api/save/load':
                fpath = Path(body['path'])
                if not fpath.is_file():
                    return self.send_json(404, {'error': f'File not found: {fpath}'})
                data, fmt, raw_len = read_save_file(fpath)
                return self.send_json(200, {
                    'path': str(fpath),
                    'name': fpath.name,
                    'format': fmt,
                    'rawBytes': raw_len,
                    'data': data,
                })

            if path == '/api/save/upload':
                b64 = body['contentBase64']
                raw = base64.b64decode(b64)
                data, fmt = parse_save_bytes(raw)
                return self.send_json(200, {
                    'name': body.get('name', 'uploaded.save'),
                    'path': '',
                    'format': fmt,
                    'rawBytes': len(raw),
                    'data': data,
                })

            if path == '/api/save/write':
                target = Path(body['path'])
                data = body['data']
                fmt = body.get('format', 'compressed')
                secret_mode = body.get('secretMode', 'keep')
                create_backup = body.get('createBackup', True)
                res = write_save_file(target, data, fmt=fmt, secret_mode=secret_mode, create_backup=create_backup)
                return self.send_json(200, res)

            if path == '/api/save/save-as':
                name = body['name'].strip()
                if not (name.endswith('.save') or name.endswith('.json')):
                    name += '.save'
                directory = Path(body.get('dir') or SAVES_DIR)
                target = directory / name
                data = body['data']
                fmt = body.get('format', 'compressed')
                secret_mode = body.get('secretMode', 'keep')
                res = write_save_file(target, data, fmt=fmt, secret_mode=secret_mode, create_backup=True)
                return self.send_json(200, res)

            if path == '/api/save/export':
                data = body['data']
                fmt = body.get('format', 'compressed')
                secret_mode = body.get('secretMode', 'keep')
                out_data = dict(data)
                if secret_mode == 'remove':
                    out_data.pop('Secret', None)
                elif secret_mode == 'recompute':
                    out_data['Secret'] = compute_secret(out_data)
                if fmt == 'pretty':
                    out_bytes = json.dumps(out_data, indent=2, ensure_ascii=False).encode('utf-8')
                elif fmt == 'uncompressed':
                    out_bytes = json.dumps(out_data, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
                else:
                    buf = io.BytesIO()
                    with gzip.GzipFile(fileobj=buf, mode='wb') as gz:
                        gz.write(json.dumps(out_data, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))
                    out_bytes = buf.getvalue()
                return self.send_json(200, {
                    'contentBase64': base64.b64encode(out_bytes).decode('ascii'),
                    'bytes': len(out_bytes),
                })

            if path == '/api/backup/restore':
                backup_path = Path(body['backupPath'])
                target_path = Path(body['targetPath'])
                if not backup_path.is_file():
                    return self.send_json(404, {'error': f'Backup not found: {backup_path}'})
                if target_path.exists():
                    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
                    pre = backup_dir_for(target_path) / f'{target_path.stem}_pre_restore_{ts}{target_path.suffix}'
                    shutil.copy2(target_path, pre)
                shutil.copy2(backup_path, target_path)
                data, fmt, raw_len = read_save_file(target_path)
                return self.send_json(200, {
                    'ok': True,
                    'path': str(target_path),
                    'name': target_path.name,
                    'format': fmt,
                    'rawBytes': raw_len,
                    'data': data,
                })

            if path == '/api/shutdown':
                self.send_json(200, {'ok': True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return

            return self.send_json(404, {'error': f'Unknown API route: {path}'})
        except Exception as ex:
            return self.send_json(500, {'error': str(ex)})

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, *_args):
        pass


def is_already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=1) as r:
            info = json.loads(r.read().decode('utf-8'))
            return info.get('app') == 'KingdomIncSaveEditor'
    except Exception:
        return False


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=48176)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    url = f'http://127.0.0.1:{args.port}'

    if is_already_running(args.port):
        print(f'Kingdom Inc Save Editor already running at {url}', flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        raise SystemExit(0)

    server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(SaveEditorHandler, directory=str(ROOT)))
    print(f'Kingdom Inc Save Editor: {url}', flush=True)
    if not args.no_browser:
        threading.Timer(0.35, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

