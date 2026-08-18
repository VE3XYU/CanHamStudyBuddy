// Display names for each exam section — the official ISED Advanced qualification
// syllabus section titles. The source question bank only numbers sections
// (A-001 … A-007) with no titles, so they're kept here; these are display-only
// and the questions themselves come from the data.
export const SECTION_TITLES = {
  1: "Advanced Theory",
  2: "Advanced Components and Circuits",
  3: "Measurements",
  4: "Power Supplies",
  5: "Transmitters, Modulation and Processing",
  6: "Receivers",
  7: "Feedlines - Matching and Antenna Systems",
};

// Compact section names for tight spots — the Progress view's sticky table
// column can't afford the full syllabus titles.
export const SECTION_SHORT = {
  1: "Theory",
  2: "Components",
  3: "Measurements",
  4: "Power Supplies",
  5: "Transmitters",
  6: "Receivers",
  7: "Antennas",
};

export function sectionShortLabel(n) {
  const title = SECTION_SHORT[n];
  return title ? `${n}. ${title}` : `Section ${n}`;
}

export function sectionLabel(n) {
  const title = SECTION_TITLES[n];
  return title ? `${n}. ${title}` : `Section ${n}`;
}

// The original ID prefix for a section, e.g. 1 -> "A-001".
export function sectionCode(n) {
  return `A-${String(n).padStart(3, "0")}`;
}
