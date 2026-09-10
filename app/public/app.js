import { remainingCount } from "./summary.mjs";

const $ = (selector) => document.querySelector(selector);
let revision = 0;
let busy = false;
let refreshTimer;

async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body;
}

function showError(error) {
  $("#error").textContent = error.message;
  $("#error").hidden = false;
  $("#status").textContent = "Not saved. Please try again.";
}

function setBusy(value) {
  busy = value;
  for (const control of document.querySelectorAll("#add-form button, #items button, #items input")) {
    control.disabled = value;
  }
}

function render(data) {
  const rows = data.items.map((item) => {
    const row = document.createElement("li");
    row.className = `item${item.bought ? " is-bought" : ""}`;
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.bought;
    checkbox.disabled = busy;
    checkbox.addEventListener("change", () => mutate(`/api/items/${item.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bought: checkbox.checked }),
    }, () => { checkbox.checked = item.bought; }));
    const name = document.createElement("span");
    name.className = "item-name";
    name.textContent = item.name;
    label.append(checkbox, name);
    const quantity = document.createElement("span");
    quantity.className = "quantity";
    quantity.textContent = `x ${item.quantity}`;
    quantity.setAttribute("aria-label", `Quantity ${item.quantity}`);
    const remove = document.createElement("button");
    remove.className = "delete";
    remove.type = "button";
    remove.textContent = "\u00d7";
    remove.setAttribute("aria-label", `Delete ${item.name}`);
    remove.disabled = busy;
    remove.addEventListener("click", () => mutate(`/api/items/${item.id}`, { method: "DELETE" }));
    row.append(label, quantity, remove);
    return row;
  });
  $("#items").replaceChildren(...rows);
  $("#remaining").textContent = remainingCount(data);
  $("#total").textContent = data.total;
  $("#bought").textContent = data.bought;
  $("#list-caption").textContent = `${data.items.length} ${data.items.length === 1 ? "item" : "items"}${$("#search").value.trim() ? " matching your search" : " on your list"}`;
  $("#empty").hidden = rows.length !== 0;
  $("#empty-title").textContent = data.total ? "Nothing matches just yet." : "A fresh start.";
  $("#empty-detail").textContent = data.total ? "Try a different search." : "Add your first item above.";
  $("#status").textContent = "Saved to your local JSON file";
}

async function refresh() {
  const current = ++revision;
  const query = new URLSearchParams({ q: $("#search").value, sort: $("#sort").value });
  const data = await api(`/api/items?${query}`);
  if (current === revision) render(data);
}

async function mutate(path, options, undo = () => {}, afterSave = () => {}) {
  if (busy) {
    undo();
    return;
  }
  setBusy(true);
  $("#error").hidden = true;
  $("#status").textContent = "Saving...";
  ++revision;
  try {
    await api(path, options);
    afterSave();
  } catch (error) {
    undo();
    showError(error);
    setBusy(false);
    return;
  }
  try {
    await refresh();
  } catch (error) {
    $("#error").textContent = `Saved, but the list could not refresh: ${error.message}`;
    $("#error").hidden = false;
    $("#status").textContent = "Saved. Refresh the page to see the latest list.";
  } finally {
    setBusy(false);
  }
}

$("#add-form").addEventListener("submit", (event) => {
  event.preventDefault();
  mutate("/api/items", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: $("#item-name").value, quantity: Number($("#item-quantity").value) }),
  }, undefined, () => {
    $("#add-form").reset();
    $("#item-name").focus();
  });
});
$("#search").addEventListener("input", () => {
  ++revision;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(showError), 120);
});
$("#sort").addEventListener("change", () => refresh().catch(showError));
refresh().catch(showError);
