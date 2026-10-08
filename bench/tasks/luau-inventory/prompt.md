Build the shared **inventory, item stacking and crafting system** for a Roblox survival game, as pure Luau modules in this repository (it currently contains only a README, a `.gitignore` and a Rojo `default.project.json` that maps `src/shared` to `ReplicatedStorage.Shared`).

## Runtime and project rules

- There is no Roblox engine here. The code runs under **[Lune](https://lune-org.github.io/docs)** (`lune` 0.10, already installed and on your `PATH`). Run a script with `lune run path/to/script.luau`.
- Put the modules in `src/shared/` as ModuleScripts (`.luau` files that `return` a table), so the same files work in Studio through Rojo. Modules must require each other with **relative string requires**, which Lune resolves relative to the requiring file, e.g. in `src/shared/Inventory.luau`: `local Signal = require("./Signal")`.
- Do **not** use `game`, `game:GetService`, `workspace`, `Instance`, `script`, `task` or any other Roblox-only API: they do not exist under Lune, and every module must load and work without them. No third-party packages (no Wally); write the `Signal` yourself.
- Every file under `src/` starts with `--!strict` and uses type annotations. Export the public types (at least `export type` for the inventory and the item definition).
- Keep all inventory state inside the inventory objects (no `_G`, no `shared`, no global variables): several inventories must be fully independent.
- Write your own tests in `tests/run.luau`. `lune run tests/run.luau` (from the repository root) must run them and exit with a non-zero status if any test fails. You can write a tiny assertion helper yourself.

Your modules are checked automatically by requiring them from a script at the repository root level, so the paths, names, return values and error messages below must match **exactly**. When an error must be raised, call `error(...)` with the given message; it is matched as a substring, so the position prefix that `error` adds is fine. "Positive integer" means a number `n` with `n >= 1` and `n == math.floor(n)`.

## `src/shared/Items.luau`

The item catalogue. Returns a module with:

- `Items.get(itemId: string): ItemDef?` — the definition, or `nil` for an unknown id.
- `Items.maxStack(itemId: string): number` — the stack limit; errors `unknown item: <itemId>` for an unknown id.

`export type ItemDef = { id: string, name: string, maxStack: number }`. The catalogue must contain exactly these items (you may choose the display names):

| id | maxStack |
|---|---|
| `wood` | 64 |
| `plank` | 64 |
| `stick` | 64 |
| `stone` | 64 |
| `iron_ingot` | 32 |
| `apple` | 16 |
| `pickaxe` | 1 |
| `sword` | 1 |

## `src/shared/Signal.luau`

A minimal Roblox-style signal.

- `Signal.new()` returns a signal with `:Connect(fn)`, `:Fire(...)` and `:DisconnectAll()`.
- `:Connect(fn)` returns a connection with a boolean field `Connected` (`true` on creation) and a method `:Disconnect()`, which sets `Connected` to `false`. Calling `:Disconnect()` more than once is harmless.
- `:Fire(...)` calls every connected handler synchronously, in the order they were connected, passing all arguments through. A handler disconnected before its turn (also during the same `Fire`, e.g. by an earlier handler) is not called; a handler connected during a `Fire` is first called by the next `Fire`.
- `:DisconnectAll()` disconnects every connection (their `Connected` becomes `false`).

## `src/shared/Inventory.luau`

A fixed number of numbered slots (`1 .. capacity`); each slot is empty or holds a stack of one item id with a count between 1 and that item's `maxStack`.

- `Inventory.new(capacity: number)` — errors `invalid capacity` unless `capacity` is a positive integer. All slots start empty.
- `inv.capacity` — the number of slots.
- `inv.changed` — a `Signal` (see above). It fires **once per call that actually changed the inventory**, with a single argument: an array of the changed slot indices, sorted ascending, each listed once. It does not fire when a call changes nothing.
- `inv:getSlot(slot: number): { itemId: string, count: number }?` — a **copy** of the slot's stack (modifying it must not affect the inventory), or `nil` if empty. Errors `invalid slot` unless `slot` is an integer in `1 .. capacity`. This rule applies to every method that takes a slot.
- `inv:count(itemId: string): number` — the total amount of that item across all slots (0 if none; unknown ids simply give 0).
- `inv:add(itemId: string, count: number): number` — adds as much as fits and returns the **leftover** that did not fit (0 if everything fit). It first tops up existing stacks of the same item in ascending slot order (up to `maxStack`), then fills empty slots in ascending slot order, each new stack holding at most `maxStack`. Errors `unknown item: <itemId>` for an unknown item and `invalid count` unless `count` is a positive integer (the item check comes first).
- `inv:canAdd(itemId: string, count: number): boolean` — `true` when `add` would have a leftover of 0. Never changes the inventory. Same errors as `add`.
- `inv:remove(itemId: string, count: number): boolean` — all or nothing: if the inventory holds fewer than `count` of the item, returns `false` and changes nothing. Otherwise removes `count`, taking from the stack in the **highest-numbered slot first** and moving towards slot 1; stacks that reach 0 become empty slots. Returns `true`. Same errors as `add`.
- `inv:move(from: number, to: number): boolean` — moves the stack in `from` onto `to`:
  - `from` empty, or `from == to` → `false`, nothing changes;
  - `to` empty → the whole stack moves, `from` becomes empty;
  - same item in both → merge: move as much as fits into `to` (up to `maxStack`); the rest stays in `from` (`from` becomes empty if everything moved). If `to` is already full, nothing moves and the result is `false`;
  - different items → the two stacks swap.
  
  Returns `true` whenever something changed.
- `inv:serialize(): SaveData` — a plain table suitable for a DataStore (only strings, numbers and tables; no functions, no metatables, no array holes), independent of the inventory (changing one never affects the other):
  ```lua
  { version = 2, capacity = 9, slots = { { slot = 1, itemId = "wood", count = 10 }, { slot = 4, itemId = "sword", count = 1 } } }
  ```
  `slots` lists only the non-empty slots, sorted by `slot` ascending.
- `Inventory.SAVE_VERSION` — the number `2`.
- `Inventory.deserialize(data: any)` — builds a new inventory from saved data (it does not keep references to `data`). It accepts:
  - version 2: the format produced by `serialize`;
  - version 1 (legacy saves): `{ version = 1, capacity = <n>, items = { { id = "wood", count = 10 }, { id = "apple", count = 3 }, ... } }` — a dense array whose entries go into slots `1, 2, 3, ...` in order.

  Errors: `unsupported save version: <version>` if `version` is a number other than 1 or 2; `unknown item: <itemId>` for an unknown item id; `invalid save data` for anything else that is wrong (not a table, missing or non-number `version`, invalid capacity, a slot outside `1 .. capacity` or listed twice, more legacy items than capacity, a count that is not a positive integer or exceeds the item's `maxStack`).

## `src/shared/Crafting.luau`

- `Crafting.recipes` — a table keyed by recipe id. Each recipe is `{ id: string, inputs: { { itemId: string, count: number } }, output: { itemId: string, count: number } }`. It must contain exactly these recipes:

  | id | inputs | output |
  |---|---|---|
  | `planks` | 1 `wood` | 4 `plank` |
  | `sticks` | 2 `plank` | 4 `stick` |
  | `pickaxe` | 3 `stone`, 2 `stick` | 1 `pickaxe` |
  | `sword` | 2 `iron_ingot`, 1 `stick` | 1 `sword` |

- `Crafting.canCraft(inv, recipeId: string, times: number?): boolean` — `times` defaults to 1. `true` when the inventory holds every input × `times` **and** the whole output × `times` fits after those inputs have been removed (removed exactly as `inv:remove` would, so a slot freed by the inputs can receive the output). Never changes the inventory. Errors `unknown recipe: <recipeId>` for an unknown recipe and `invalid count` unless `times` is a positive integer.
- `Crafting.craft(inv, recipeId: string, times: number?): boolean` — if `canCraft` is false, returns `false` and changes nothing. Otherwise removes all inputs (in the order they are listed in the recipe, each like `inv:remove`) and then adds the output (like `inv:add`), atomically: `inv.changed` fires **exactly once** for the whole craft, with every slot the craft touched. Returns `true`. Same errors as `canCraft`.

## Example

```lua
local Inventory = require("./src/shared/Inventory")
local Crafting = require("./src/shared/Crafting")

local inv = Inventory.new(4)
inv.changed:Connect(function(slots) print("changed", table.concat(slots, ",")) end)
print(inv:add("wood", 70))              -- changed 1,2   then 0
print(Crafting.craft(inv, "planks", 2)) -- changed 2,3   then true  (wood 64 + 4, planks 8 in slot 3)
print(inv:count("plank"))               -- 8
```

Also add a short section to `README.md` explaining how to run your tests.
