# Kingdom Inc Save Editor

A standalone local save editor for **Kingdom Inc** (`1.0.14+` and modded saves), built with native game icons, fonts, and full schema coverage. It runs locally in your browser with zero external network access.

**Python 3.10+ is required** on Windows (`python.exe` or `pythonw.exe` on your system `PATH`). Install Python from [python.org](https://www.python.org/downloads/) and check **"Add Python to PATH"** during setup.

## Features

- **Save Discovery & Automatic Backups**: Automatically lists `.save` and `.json` files from your Kingdom Inc Saves folder, supports drag-and-drop from anywhere on disk, reads and writes GZip-compressed `.save` or JSON formats, and creates automatic `.bak` and timestamped `.saveeditor_backups/` snapshots before every write (with a built-in **Backups & Restore** viewer and **Pending Changes Diff**).
- **Overview, Currencies & Progression**: Edit `Version`, `GameTime`, `CurrentFlow`, `AscensionCount`, Nightmare settings, all 9 currencies (`Balance`, `Total Earned`, `Exchange Rate`), and modded keys such as `KingdomStudioWallets`.
- **Tech Tree & Prestige**: Searchable, branch-filterable browser for all 588 Tech Nodes (toggle individually, by branch, or all at once) plus all 9 Prestige Nodes with live calculated bonus values.
- **Resources, Forest, Farm & Requisitions**: Edit resource quotas and upgrade levels, Forest worker allocations and unlocked items, an interactive visual Farm crop grid painter, and active Requisition types.
- **Flow Diagrams Studio**: Interactive pan-and-zoom 2D canvas rendering elements, IO ports, pipes, and decoration zones using the game's exact prefab dimensions and top-left alignment. Includes drag-and-drop placement, 64px grid snapping, box multi-select, alignment and distribution tools, automatic orthogonal pipe routing, smart snap guides, and a deep per-element inspector.
- **Deep Item, Equipment & Adventurer Editor**: Edit item types, quality (`:q`), seeds (`:s`), stats, enhancements (`Engrave`, `Enchant`, `Blessing`), combatant health/energy/level, and recursively inspect or edit equipped gear.
- **Armory & Portal Matrix**: Inspect and edit all 8 color-coded Armory channels and the 8x8 (64-slot) Portal network.
- **Wars, Dungeons, Quests & Building Upgrades**: Edit progress across all 4 Wars, 6 Dungeons (unlocks and per-stage clears/wipes), 14 Quests, `UpgradeCounts`, and `UnlockedFlowUpgrades`.
- **Save Bloat Scanner & Cleaner**: Diagnoses oversized saves (`WarEffort.Soldiers`, `FlowIO.BufferedItems`, `Stockpile.Contents`, `Armory`, `Portal`, orphaned/duplicate pipes, redundant pipe waypoints, default fields, and verbose floats) with one-click lossless cleanup and configurable trimmers.
- **Register & Raw JSON**: Edit `Register` (`Flags`, `Counters`, `Data`) and full raw JSON, preserving all modded fields losslessly.

## Installation & Usage

1. Extract the release archive anywhere on your PC (or clone the repository).
2. Double-click **Launch Save Editor.cmd** (or run `python server.py` and open `http://127.0.0.1:48176`).
3. Close the game or avoid overwriting an active save while the game is saving; reload your save in-game after editing.
4. To stop the background server, run **Stop-SaveEditor.ps1**.

## Requirements

- **Python 3.10 or newer is required** on Windows (`python.exe` / `pythonw.exe` available on `PATH` — check **"Add Python to PATH"** when installing from [python.org](https://www.python.org/downloads/)).
- Any modern web browser.
- No BepInEx or in-game mod installation required.

## Compatibility

This is a standalone external save-file tool and applies no runtime hooks or Harmony patches to Kingdom Inc.

| Class.Method | Hook Type | Impact |
| --- | --- | --- |
| None (external tool) | None | Reads and writes `.save` / `.json` files offline with automatic `.bak` backups |
