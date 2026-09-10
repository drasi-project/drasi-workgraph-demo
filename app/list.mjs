import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class InputError extends Error {}

function validateItem(item) {
  if (
    !item || typeof item.id !== "string" || !item.id ||
    typeof item.name !== "string" || !item.name.trim() || item.name.length > 80 ||
    !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99 ||
    typeof item.bought !== "boolean"
  ) {
    throw new Error("Invalid item in the shopping-list data file.");
  }
}

export function selectItems(items, query = "", sort = "added") {
  const selected = items.filter((item) => item.name.includes(query.trim()));
  if (sort === "name") selected.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "quantity") {
    selected.sort((a, b) => String(a.quantity).localeCompare(String(b.quantity)));
  }
  return selected;
}

export function createStore(dataFile) {
  mkdirSync(dirname(dataFile), { recursive: true });
  try {
    readFileSync(dataFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    writeFileSync(dataFile, readFileSync(new URL("./seed.json", import.meta.url)), {
      flag: "wx", mode: 0o600,
    });
  }

  function read() {
    const data = JSON.parse(readFileSync(dataFile, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.items)) {
      throw new Error("Unsupported shopping-list data file. See app/README.md.");
    }
    data.items.forEach(validateItem);
    if (new Set(data.items.map((item) => item.id)).size !== data.items.length) {
      throw new Error("Duplicate item IDs in the shopping-list data file.");
    }
    return data.items;
  }

  function write(items) {
    const temporary = `${dataFile}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, {
        flag: "wx", mode: 0o600,
      });
      renameSync(temporary, dataFile);
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  read();
  return {
    read,
    add(input) {
      if (!input || Array.isArray(input) || Object.keys(input).some((key) => !["name", "quantity"].includes(key))) {
        throw new InputError("Provide only an item name and quantity.");
      }
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const quantity = input.quantity === undefined ? 1 : input.quantity;
      if (!name || name.length > 80) throw new InputError("Use an item name between 1 and 80 characters.");
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        throw new InputError("Quantity must be a whole number between 1 and 99.");
      }
      const items = read();
      const item = { id: randomUUID(), name, quantity, bought: false };
      write([...items, item]);
      return item;
    },
    update(id, input) {
      if (
        !input || Array.isArray(input) || typeof input.bought !== "boolean" ||
        Object.keys(input).some((key) => key !== "bought")
      ) {
        throw new InputError("Provide only bought: true or bought: false.");
      }
      const items = read();
      const item = items.find((entry) => entry.id === id);
      if (!item) return null;
      item.bought = input.bought;
      write(items);
      return item;
    },
    remove(id) {
      const items = read();
      if (!items.some((item) => item.id === id)) return false;
      write(items.filter((item) => item.id !== id));
      return true;
    },
  };
}
