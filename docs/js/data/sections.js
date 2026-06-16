// Display names for each exam section.
//
// The source question bank only numbers sections (A-001 … A-007); it does not
// include topic titles. These labels are display-only — rename them to match
// the ISED Advanced syllabus topics however you like. Section numbers and the
// questions in them come from the data, not from here.
export const SECTION_TITLES = {
  1: "Section 1",
  2: "Section 2",
  3: "Section 3",
  4: "Section 4",
  5: "Section 5",
  6: "Section 6",
  7: "Section 7",
};

export function sectionLabel(n) {
  return SECTION_TITLES[n] || `Section ${n}`;
}

// The original ID prefix for a section, e.g. 1 -> "A-001".
export function sectionCode(n) {
  return `A-${String(n).padStart(3, "0")}`;
}
