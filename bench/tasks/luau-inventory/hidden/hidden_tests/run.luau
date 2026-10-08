-- Black-box tests for src/shared/{Items,Signal,Inventory,Crafting}.luau.
-- Prints one line per test: "ok <name>" or "not ok <name> - <message>".

local cache: { [string]: { ok: boolean, value: any } } = {}

-- Requires each module once; a module that failed to load re-raises its first error.
local function load(name: string): any
	local hit = cache[name]
	if hit == nil then
		local ok, value = pcall(function(): any
			if name == "Items" then
				return require("../src/shared/Items")
			elseif name == "Signal" then
				return require("../src/shared/Signal")
			elseif name == "Inventory" then
				return require("../src/shared/Inventory")
			else
				return require("../src/shared/Crafting")
			end
		end)
		hit = { ok = ok, value = value }
		cache[name] = hit
	end
	if not hit.ok then
		error("cannot load " .. name .. ": " .. tostring(hit.value), 0)
	end
	return hit.value
end

local function Items() return load("Items") end
local function Signal() return load("Signal") end
local function Inventory() return load("Inventory") end
local function Crafting() return load("Crafting") end

local function fmt(v: any): string
	if type(v) == "string" then
		return string.format("%q", v)
	end
	return tostring(v)
end

local function eq(actual: any, expected: any, what: string?)
	if actual ~= expected then
		error(string.format("%s: expected %s, got %s", what or "value", fmt(expected), fmt(actual)), 0)
	end
end

local function truthy(v: any, what: string)
	if not v then
		error(what .. ": expected truthy, got " .. fmt(v), 0)
	end
end

local function list(actual: any, expected: { any }, what: string?)
	if type(actual) ~= "table" then
		error((what or "list") .. ": expected a table, got " .. fmt(actual), 0)
	end
	local a = {}
	for i, v in actual do
		a[i] = fmt(v)
	end
	local e = {}
	for i, v in expected do
		e[i] = fmt(v)
	end
	local sa, se = table.concat(a, ","), table.concat(e, ",")
	if sa ~= se or #actual ~= #expected then
		error(string.format("%s: expected {%s}, got {%s}", what or "list", se, sa), 0)
	end
end

local function throws(fn: () -> any, needle: string)
	local ok, err = pcall(fn)
	if ok then
		error("expected an error containing " .. fmt(needle) .. ", but nothing was raised", 0)
	end
	local msg = tostring(err)
	if not string.find(msg, needle, 1, true) then
		error("expected an error containing " .. fmt(needle) .. ", got " .. fmt(msg), 0)
	end
end

-- Asserts the full content of an inventory: layout maps slot -> {itemId, count}.
local function layout(inv: any, expected: { [number]: { any } })
	for slot = 1, inv.capacity do
		local s = inv:getSlot(slot)
		local e = expected[slot]
		if e == nil then
			if s ~= nil then
				error(string.format("slot %d: expected empty, got %s x%s", slot, fmt(s.itemId), fmt(s.count)), 0)
			end
		else
			if s == nil then
				error(string.format("slot %d: expected %s x%d, got empty", slot, e[1], e[2]), 0)
			end
			if s.itemId ~= e[1] or s.count ~= e[2] then
				error(string.format("slot %d: expected %s x%d, got %s x%s", slot, e[1], e[2], fmt(s.itemId), fmt(s.count)), 0)
			end
		end
	end
end

-- Records the arguments of every `changed` event.
local function recorder(inv: any): { { number } }
	local events = {}
	inv.changed:Connect(function(slots)
		local copy = {}
		for i, v in slots do
			copy[i] = v
		end
		table.insert(events, copy)
	end)
	return events
end

local tests: { { name: string, fn: () -> () } } = {}
local function test(name: string, fn: () -> ())
	table.insert(tests, { name = name, fn = fn })
end

---------------------------------------------------------------- items
test("items_stack_limits", function()
	local I = Items()
	local expected = { wood = 64, plank = 64, stick = 64, stone = 64, iron_ingot = 32, apple = 16, pickaxe = 1, sword = 1 }
	for id, max in expected do
		eq(I.maxStack(id), max, "maxStack(" .. id .. ")")
		local def = I.get(id)
		truthy(def, "get(" .. id .. ")")
		eq(def.id, id, "get(" .. id .. ").id")
		eq(def.maxStack, max, "get(" .. id .. ").maxStack")
		eq(type(def.name), "string", "get(" .. id .. ").name type")
	end
end)

test("items_unknown", function()
	local I = Items()
	eq(I.get("diamond"), nil, "get(diamond)")
	throws(function() return I.maxStack("diamond") end, "unknown item: diamond")
end)

---------------------------------------------------------------- signal
test("signal_fires_in_order_with_args", function()
	local s = Signal().new()
	local log = {}
	s:Connect(function(a, b) table.insert(log, "1:" .. tostring(a) .. tostring(b)) end)
	s:Connect(function(a, b) table.insert(log, "2:" .. tostring(a) .. tostring(b)) end)
	s:Fire("x", 7)
	list(log, { "1:x7", "2:x7" })
end)

test("signal_disconnect", function()
	local s = Signal().new()
	local n = 0
	local c = s:Connect(function() n += 1 end)
	eq(c.Connected, true, "Connected after Connect")
	s:Fire()
	c:Disconnect()
	eq(c.Connected, false, "Connected after Disconnect")
	c:Disconnect()
	s:Fire()
	eq(n, 1, "calls")
end)

test("signal_disconnect_during_fire", function()
	local s = Signal().new()
	local log = {}
	local second
	s:Connect(function()
		table.insert(log, "a")
		second:Disconnect()
	end)
	second = s:Connect(function() table.insert(log, "b") end)
	s:Connect(function() table.insert(log, "c") end)
	s:Fire()
	list(log, { "a", "c" })
end)

test("signal_connect_during_fire", function()
	local s = Signal().new()
	local log = {}
	local added = false
	s:Connect(function()
		table.insert(log, "a")
		if not added then
			added = true
			s:Connect(function() table.insert(log, "late") end)
		end
	end)
	s:Fire()
	list(log, { "a" }, "first fire")
	s:Fire()
	list(log, { "a", "a", "late" }, "second fire")
end)

test("signal_disconnect_all", function()
	local s = Signal().new()
	local n = 0
	local c1 = s:Connect(function() n += 1 end)
	local c2 = s:Connect(function() n += 1 end)
	s:DisconnectAll()
	s:Fire()
	eq(n, 0, "calls")
	eq(c1.Connected, false, "c1.Connected")
	eq(c2.Connected, false, "c2.Connected")
end)

---------------------------------------------------------------- new / getSlot
test("new_empty_inventory", function()
	local inv = Inventory().new(5)
	eq(inv.capacity, 5, "capacity")
	layout(inv, {})
	eq(inv:count("wood"), 0, "count(wood)")
	eq(inv:count("diamond"), 0, "count(unknown)")
end)

test("new_invalid_capacity", function()
	local Inv = Inventory()
	throws(function() return Inv.new(0) end, "invalid capacity")
	throws(function() return Inv.new(-3) end, "invalid capacity")
	throws(function() return Inv.new(2.5) end, "invalid capacity")
end)

test("new_getslot_invalid_slot", function()
	local inv = Inventory().new(3)
	throws(function() return inv:getSlot(0) end, "invalid slot")
	throws(function() return inv:getSlot(4) end, "invalid slot")
	throws(function() return inv:getSlot(1.5) end, "invalid slot")
end)

test("new_getslot_returns_copy", function()
	local inv = Inventory().new(3)
	inv:add("wood", 5)
	local s = inv:getSlot(1)
	s.count = 99
	s.itemId = "stone"
	layout(inv, { { "wood", 5 } })
end)

test("new_inventories_independent", function()
	local Inv = Inventory()
	local a, b = Inv.new(2), Inv.new(2)
	local ea, eb = recorder(a), recorder(b)
	a:add("wood", 3)
	layout(b, {})
	eq(#eb, 0, "events on b")
	eq(#ea, 1, "events on a")
	eq(b:count("wood"), 0, "b wood")
end)

---------------------------------------------------------------- add
test("add_stacks_and_returns_zero", function()
	local inv = Inventory().new(4)
	eq(inv:add("wood", 10), 0, "leftover")
	eq(inv:add("wood", 5), 0, "leftover")
	layout(inv, { { "wood", 15 } })
	eq(inv:count("wood"), 15, "count")
end)

test("add_splits_by_max_stack", function()
	local inv = Inventory().new(4)
	eq(inv:add("apple", 40), 0, "leftover")
	layout(inv, { { "apple", 16 }, { "apple", 16 }, { "apple", 8 } })
end)

test("add_tops_up_existing_before_empty_slots", function()
	local inv = Inventory().new(4)
	inv:add("stone", 1)
	inv:add("wood", 60)
	inv:add("stone", 1)
	inv:move(2, 4) -- wood to slot 4, stone stays in slot 1
	eq(inv:add("wood", 10), 0, "leftover")
	layout(inv, { { "stone", 2 }, { "wood", 6 }, nil, { "wood", 64 } })
end)

test("add_returns_leftover_when_full", function()
	local inv = Inventory().new(2)
	eq(inv:add("iron_ingot", 70), 6, "leftover")
	layout(inv, { { "iron_ingot", 32 }, { "iron_ingot", 32 } })
	eq(inv:add("wood", 3), 3, "leftover when no room")
	layout(inv, { { "iron_ingot", 32 }, { "iron_ingot", 32 } })
end)

test("add_unstackable_items", function()
	local inv = Inventory().new(3)
	eq(inv:add("sword", 2), 0, "leftover")
	eq(inv:add("pickaxe", 2), 1, "leftover")
	layout(inv, { { "sword", 1 }, { "sword", 1 }, { "pickaxe", 1 } })
end)

test("add_errors", function()
	local inv = Inventory().new(3)
	throws(function() return inv:add("diamond", 1) end, "unknown item: diamond")
	throws(function() return inv:add("wood", 0) end, "invalid count")
	throws(function() return inv:add("wood", -2) end, "invalid count")
	throws(function() return inv:add("wood", 1.5) end, "invalid count")
	throws(function() return inv:add("diamond", 0) end, "unknown item: diamond")
	layout(inv, {})
end)

test("add_can_add", function()
	local inv = Inventory().new(2)
	inv:add("apple", 10)
	eq(inv:canAdd("apple", 22), true, "canAdd 22")
	eq(inv:canAdd("apple", 23), false, "canAdd 23")
	eq(inv:canAdd("sword", 1), true, "canAdd sword")
	layout(inv, { { "apple", 10 } })
	throws(function() return inv:canAdd("diamond", 1) end, "unknown item: diamond")
	throws(function() return inv:canAdd("apple", 0) end, "invalid count")
end)

---------------------------------------------------------------- remove
test("remove_from_highest_slot_first", function()
	local inv = Inventory().new(4)
	inv:add("wood", 64 + 64 + 10)
	eq(inv:remove("wood", 20), true, "result")
	layout(inv, { { "wood", 64 }, { "wood", 54 } })
	eq(inv:count("wood"), 118, "count")
end)

test("remove_all_or_nothing", function()
	local inv = Inventory().new(3)
	inv:add("stone", 5)
	local events = recorder(inv)
	eq(inv:remove("stone", 6), false, "result")
	eq(inv:remove("wood", 1), false, "absent item")
	layout(inv, { { "stone", 5 } })
	eq(#events, 0, "events")
end)

test("remove_empties_slots", function()
	local inv = Inventory().new(3)
	inv:add("stone", 5)
	inv:add("apple", 3)
	eq(inv:remove("stone", 5), true, "result")
	layout(inv, { nil, { "apple", 3 } })
	eq(inv:add("wood", 1), 0, "leftover")
	layout(inv, { { "wood", 1 }, { "apple", 3 } })
end)

test("remove_errors", function()
	local inv = Inventory().new(3)
	inv:add("wood", 5)
	throws(function() return inv:remove("diamond", 1) end, "unknown item: diamond")
	throws(function() return inv:remove("wood", 0) end, "invalid count")
	throws(function() return inv:remove("wood", 2.5) end, "invalid count")
	layout(inv, { { "wood", 5 } })
end)

---------------------------------------------------------------- move
test("move_to_empty_slot", function()
	local inv = Inventory().new(3)
	inv:add("wood", 7)
	eq(inv:move(1, 3), true, "result")
	layout(inv, { nil, nil, { "wood", 7 } })
end)

test("move_swaps_different_items", function()
	local inv = Inventory().new(3)
	inv:add("wood", 7)
	inv:add("sword", 1)
	eq(inv:move(2, 1), true, "result")
	layout(inv, { { "sword", 1 }, { "wood", 7 } })
end)

test("move_merges_same_item", function()
	local inv = Inventory().new(3)
	inv:add("apple", 16)
	inv:move(1, 3) -- slot 3: 16
	inv:add("apple", 6) -- slot 1: 6 (slot 3 is full)
	inv:remove("apple", 4) -- slot 3: 12
	layout(inv, { { "apple", 6 }, nil, { "apple", 12 } })
	eq(inv:move(1, 3), true, "partial merge result")
	layout(inv, { { "apple", 2 }, nil, { "apple", 16 } })
	eq(inv:move(1, 3), false, "merge onto full stack")
	layout(inv, { { "apple", 2 }, nil, { "apple", 16 } })
	eq(inv:move(3, 1), true, "merge everything that fits")
	layout(inv, { { "apple", 16 }, nil, { "apple", 2 } })
end)

test("move_full_merge_empties_source", function()
	local inv = Inventory().new(3)
	inv:add("apple", 16)
	inv:move(1, 3) -- slot 3: 16
	inv:add("apple", 4) -- slot 1: 4
	inv:remove("apple", 6) -- slot 3: 10
	layout(inv, { { "apple", 4 }, nil, { "apple", 10 } })
	eq(inv:move(1, 3), true, "result")
	layout(inv, { nil, nil, { "apple", 14 } })
end)

test("move_noop_cases", function()
	local inv = Inventory().new(3)
	inv:add("wood", 5)
	local events = recorder(inv)
	eq(inv:move(2, 1), false, "from empty")
	eq(inv:move(1, 1), false, "same slot")
	layout(inv, { { "wood", 5 } })
	eq(#events, 0, "events")
end)

test("move_invalid_slot", function()
	local inv = Inventory().new(3)
	inv:add("wood", 5)
	throws(function() return inv:move(1, 4) end, "invalid slot")
	throws(function() return inv:move(0, 1) end, "invalid slot")
	throws(function() return inv:move(1, 2.5) end, "invalid slot")
	layout(inv, { { "wood", 5 } })
end)

---------------------------------------------------------------- events
test("events_add_fires_once_sorted", function()
	local inv = Inventory().new(5)
	inv:add("stone", 1)
	inv:add("wood", 60)
	inv:move(1, 4)
	local events = recorder(inv)
	inv:add("wood", 80) -- slot 2 -> 64, then slot 1 (64), slot 3 (12)
	eq(#events, 1, "event count")
	list(events[1], { 1, 2, 3 }, "changed slots")
end)

test("events_not_fired_without_change", function()
	local inv = Inventory().new(1)
	inv:add("sword", 1)
	local events = recorder(inv)
	eq(inv:add("sword", 1), 1, "leftover")
	eq(inv:remove("stone", 1), false, "remove")
	eq(inv:canAdd("wood", 1), false, "canAdd")
	inv:count("sword")
	inv:getSlot(1)
	inv:serialize()
	eq(#events, 0, "event count")
end)

test("events_remove_and_move", function()
	local inv = Inventory().new(4)
	inv:add("wood", 100) -- 64, 36
	local events = recorder(inv)
	inv:remove("wood", 40) -- slot 2 empty, slot 1 -> 60
	inv:move(1, 4)
	inv:add("stone", 2) -- slot 1
	inv:move(4, 1) -- swap
	eq(#events, 4, "event count")
	list(events[1], { 1, 2 }, "remove")
	list(events[2], { 1, 4 }, "move")
	list(events[3], { 1 }, "add")
	list(events[4], { 1, 4 }, "swap")
end)

test("events_disconnect_stops_delivery", function()
	local inv = Inventory().new(2)
	local n = 0
	local c = inv.changed:Connect(function() n += 1 end)
	inv:add("wood", 1)
	c:Disconnect()
	inv:add("wood", 1)
	eq(n, 1, "calls")
end)

---------------------------------------------------------------- save / load
test("save_serialize_format", function()
	local Inv = Inventory()
	eq(Inv.SAVE_VERSION, 2, "SAVE_VERSION")
	local inv = Inv.new(9)
	inv:add("wood", 10)
	inv:add("sword", 1)
	inv:move(2, 4)
	local data = inv:serialize()
	eq(data.version, 2, "version")
	eq(data.capacity, 9, "capacity")
	eq(#data.slots, 2, "#slots")
	eq(data.slots[1].slot, 1, "slots[1].slot")
	eq(data.slots[1].itemId, "wood", "slots[1].itemId")
	eq(data.slots[1].count, 10, "slots[1].count")
	eq(data.slots[2].slot, 4, "slots[2].slot")
	eq(data.slots[2].itemId, "sword", "slots[2].itemId")
	eq(data.slots[2].count, 1, "slots[2].count")
end)

local function checkPlain(v: any, path: string)
	local t = type(v)
	if t == "table" then
		if getmetatable(v) ~= nil then
			error(path .. " has a metatable", 0)
		end
		local n = 0
		for k, child in v do
			if type(k) ~= "string" and type(k) ~= "number" then
				error(path .. " has a " .. type(k) .. " key", 0)
			end
			n += 1
			checkPlain(child, path .. "." .. tostring(k))
		end
	elseif t ~= "string" and t ~= "number" and t ~= "boolean" then
		error(path .. " is a " .. t, 0)
	end
end

test("save_serialize_is_plain_and_independent", function()
	local inv = Inventory().new(3)
	inv:add("stone", 3)
	inv:add("apple", 20)
	local data = inv:serialize()
	checkPlain(data, "data")
	eq(#data.slots, 3, "#slots")
	data.slots[1].count = 99
	data.slots[2] = nil
	layout(inv, { { "stone", 3 }, { "apple", 16 }, { "apple", 4 } })
	inv:remove("stone", 3)
	eq(data.slots[1].itemId, "stone", "saved itemId after change")
	eq(#inv:serialize().slots, 2, "#slots after change")
end)

test("save_round_trip", function()
	local Inv = Inventory()
	local inv = Inv.new(6)
	inv:add("iron_ingot", 40)
	inv:add("pickaxe", 1)
	inv:move(1, 6)
	inv:move(2, 3)
	local copy = Inv.deserialize(inv:serialize())
	eq(copy.capacity, 6, "capacity")
	layout(copy, { [2] = { "pickaxe", 1 }, [3] = { "iron_ingot", 8 }, [6] = { "iron_ingot", 32 } })
	-- the restored inventory is fully functional and independent
	local events = recorder(copy)
	eq(copy:add("pickaxe", 1), 0, "leftover")
	eq(#events, 1, "events on restored inventory")
	eq(inv:count("pickaxe"), 1, "original pickaxes")
	eq(copy:count("pickaxe"), 2, "restored pickaxes")
end)

test("save_deserialize_copies_input", function()
	local Inv = Inventory()
	local data = { version = 2, capacity = 2, slots = { { slot = 2, itemId = "apple", count = 5 } } }
	local inv = Inv.deserialize(data)
	data.slots[1].count = 9
	data.slots[1].itemId = "wood"
	layout(inv, { nil, { "apple", 5 } })
	inv:add("apple", 1)
	eq(data.slots[1].count, 9, "input after add")
end)

test("save_migrates_version_1", function()
	local inv = Inventory().deserialize({
		version = 1,
		capacity = 4,
		items = { { id = "wood", count = 10 }, { id = "apple", count = 3 }, { id = "sword", count = 1 } },
	})
	eq(inv.capacity, 4, "capacity")
	layout(inv, { { "wood", 10 }, { "apple", 3 }, { "sword", 1 } })
	local data = inv:serialize()
	eq(data.version, 2, "re-saved version")
	eq(#data.slots, 3, "re-saved #slots")
end)

test("save_unsupported_version", function()
	local Inv = Inventory()
	throws(function() return Inv.deserialize({ version = 3, capacity = 2, slots = {} }) end, "unsupported save version: 3")
	throws(function() return Inv.deserialize({ version = 0, capacity = 2, slots = {} }) end, "unsupported save version: 0")
end)

test("save_unknown_item", function()
	local Inv = Inventory()
	throws(function()
		return Inv.deserialize({ version = 2, capacity = 2, slots = { { slot = 1, itemId = "diamond", count = 1 } } })
	end, "unknown item: diamond")
	throws(function()
		return Inv.deserialize({ version = 1, capacity = 2, items = { { id = "ruby", count = 1 } } })
	end, "unknown item: ruby")
end)

test("save_invalid_data", function()
	local Inv = Inventory()
	local cases: { any } = {
		"nope",
		{ capacity = 2, slots = {} },
		{ version = "2", capacity = 2, slots = {} },
		{ version = 2, capacity = 0, slots = {} },
		{ version = 2, capacity = 2, slots = { { slot = 3, itemId = "wood", count = 1 } } },
		{ version = 2, capacity = 2, slots = { { slot = 0, itemId = "wood", count = 1 } } },
		{ version = 2, capacity = 2, slots = { { slot = 1, itemId = "wood", count = 1 }, { slot = 1, itemId = "stone", count = 1 } } },
		{ version = 2, capacity = 2, slots = { { slot = 1, itemId = "wood", count = 0 } } },
		{ version = 2, capacity = 2, slots = { { slot = 1, itemId = "wood", count = 1.5 } } },
		{ version = 2, capacity = 2, slots = { { slot = 1, itemId = "apple", count = 17 } } },
		{ version = 1, capacity = 1, items = { { id = "wood", count = 1 }, { id = "stone", count = 1 } } },
		{ version = 1, capacity = 2, items = { { id = "sword", count = 2 } } },
	}
	for i, data in cases do
		local ok, err = pcall(Inv.deserialize, data)
		if ok then
			error("case " .. i .. ": expected an error", 0)
		end
		if not string.find(tostring(err), "invalid save data", 1, true) then
			error("case " .. i .. ": expected 'invalid save data', got " .. fmt(tostring(err)), 0)
		end
	end
end)

---------------------------------------------------------------- crafting
test("craft_recipes_table", function()
	local C = Crafting()
	local expected = {
		planks = { { { "wood", 1 } }, { "plank", 4 } },
		sticks = { { { "plank", 2 } }, { "stick", 4 } },
		pickaxe = { { { "stone", 3 }, { "stick", 2 } }, { "pickaxe", 1 } },
		sword = { { { "iron_ingot", 2 }, { "stick", 1 } }, { "sword", 1 } },
	}
	local n = 0
	for id in C.recipes do
		n += 1
		truthy(expected[id], "unexpected recipe " .. tostring(id))
	end
	eq(n, 4, "recipe count")
	for id, e in expected do
		local r = C.recipes[id]
		truthy(r, "recipe " .. id)
		eq(r.id, id, id .. ".id")
		eq(#r.inputs, #e[1], id .. " #inputs")
		for i, input in e[1] do
			eq(r.inputs[i].itemId, input[1], id .. " input " .. i .. " itemId")
			eq(r.inputs[i].count, input[2], id .. " input " .. i .. " count")
		end
		eq(r.output.itemId, e[2][1], id .. " output itemId")
		eq(r.output.count, e[2][2], id .. " output count")
	end
end)

test("craft_can_craft", function()
	local C = Crafting()
	local inv = Inventory().new(4)
	inv:add("stone", 3)
	inv:add("stick", 1)
	eq(C.canCraft(inv, "pickaxe"), false, "missing stick")
	inv:add("stick", 1)
	eq(C.canCraft(inv, "pickaxe"), true, "all inputs")
	eq(C.canCraft(inv, "pickaxe", 2), false, "times 2")
	eq(C.canCraft(inv, "sword"), false, "no iron")
	layout(inv, { { "stone", 3 }, { "stick", 2 } })
end)

test("craft_consumes_and_produces", function()
	local C = Crafting()
	local inv = Inventory().new(4)
	inv:add("stone", 5)
	inv:add("stick", 6)
	eq(C.craft(inv, "pickaxe"), true, "craft")
	layout(inv, { { "stone", 2 }, { "stick", 4 }, { "pickaxe", 1 } })
end)

test("craft_failure_changes_nothing", function()
	local C = Crafting()
	local inv = Inventory().new(4)
	inv:add("iron_ingot", 2)
	local events = recorder(inv)
	eq(C.craft(inv, "sword"), false, "craft without stick")
	layout(inv, { { "iron_ingot", 2 } })
	eq(#events, 0, "events")
end)

test("craft_fires_changed_once", function()
	local C = Crafting()
	local inv = Inventory().new(5)
	inv:add("iron_ingot", 40) -- 32, 8
	inv:add("stick", 3)
	local events = recorder(inv)
	eq(C.craft(inv, "sword"), true, "craft")
	eq(#events, 1, "event count")
	list(events[1], { 2, 3, 4 }, "changed slots")
	layout(inv, { { "iron_ingot", 32 }, { "iron_ingot", 6 }, { "stick", 2 }, { "sword", 1 } })
end)

test("craft_times", function()
	local C = Crafting()
	local inv = Inventory().new(4)
	inv:add("wood", 10)
	eq(C.canCraft(inv, "planks", 10), true, "canCraft x10")
	eq(C.canCraft(inv, "planks", 11), false, "canCraft x11")
	eq(C.craft(inv, "planks", 3), true, "craft x3")
	layout(inv, { { "wood", 7 }, { "plank", 12 } })
	eq(C.craft(inv, "sticks", 6), true, "sticks x6")
	layout(inv, { { "wood", 7 }, { "stick", 24 } })
end)

test("craft_uses_space_freed_by_inputs", function()
	local C = Crafting()
	local inv = Inventory().new(2)
	inv:add("wood", 1)
	inv:add("apple", 16)
	eq(C.canCraft(inv, "planks"), true, "canCraft")
	eq(C.craft(inv, "planks"), true, "craft")
	layout(inv, { { "plank", 4 }, { "apple", 16 } })
end)

test("craft_output_must_fit", function()
	local C = Crafting()
	local inv = Inventory().new(2)
	inv:add("wood", 2)
	inv:add("apple", 16)
	local events = recorder(inv)
	eq(C.canCraft(inv, "planks"), false, "canCraft")
	eq(C.craft(inv, "planks"), false, "craft")
	layout(inv, { { "wood", 2 }, { "apple", 16 } })
	eq(#events, 0, "events")
end)

test("craft_errors", function()
	local C = Crafting()
	local inv = Inventory().new(2)
	inv:add("wood", 5)
	throws(function() return C.canCraft(inv, "boat") end, "unknown recipe: boat")
	throws(function() return C.craft(inv, "boat") end, "unknown recipe: boat")
	throws(function() return C.craft(inv, "planks", 0) end, "invalid count")
	throws(function() return C.canCraft(inv, "planks", 1.5) end, "invalid count")
	layout(inv, { { "wood", 5 } })
end)

---------------------------------------------------------------- run
for _, t in tests do
	local ok, err = pcall(t.fn)
	if ok then
		print("ok " .. t.name)
	else
		local msg = string.gsub(tostring(err), "%s+", " ")
		print("not ok " .. t.name .. " - " .. msg)
	end
end
