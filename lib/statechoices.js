const SN_STATE_MAPS = {
  incident: { "1": "New", "2": "In Progress", "3": "On Hold", "6": "Resolved", "7": "Closed", "8": "Canceled" },
  change_request: { "-5": "New", "10": "Assess", "11": "Authorize", "12": "Scheduled", "-1": "Implement", "6": "Review", "7": "Closed", "8": "Canceled" },
  problem: { "-5": "New", "1": "Open", "2": "Known Error", "3": "Pending Change Request", "6": "Resolved", "7": "Closed" },
  sc_req_item: { "-5": "Pending", "1": "Open", "2": "Work in Progress", "3": "Closed Complete", "4": "Closed Incomplete", "7": "Closed Skipped" },
  sc_task: { "-5": "Pending", "1": "Open", "2": "Work in Progress", "3": "Closed Complete", "4": "Closed Incomplete", "7": "Closed Skipped" }
};

const SN_PRIORITY_CHOICES = [
  { value: "1", label: "1 - Critical" },
  { value: "2", label: "2 - High" },
  { value: "3", label: "3 - Moderate" },
  { value: "4", label: "4 - Low" }
];

function snStateMap(table) {
  const t = table || "incident";
  if (SN_STATE_MAPS[t]) return SN_STATE_MAPS[t];
  return SN_STATE_MAPS.sc_req_item;
}

function snStateChoices(table) {
  return Object.entries(snStateMap(table)).map(([value, label]) => ({ value, label }));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SN_STATE_MAPS, SN_PRIORITY_CHOICES, snStateMap, snStateChoices };
} else if (typeof self !== "undefined") {
  self.SN_STATE_MAPS = SN_STATE_MAPS;
  self.SN_PRIORITY_CHOICES = SN_PRIORITY_CHOICES;
  self.snStateMap = snStateMap;
  self.snStateChoices = snStateChoices;
}
