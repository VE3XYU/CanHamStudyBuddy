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

export function sectionLabel(n) {
  return SECTION_TITLES[n] || `Section ${n}`;
}

// The original ID prefix for a section, e.g. 1 -> "A-001".
export function sectionCode(n) {
  return `A-${String(n).padStart(3, "0")}`;
}
