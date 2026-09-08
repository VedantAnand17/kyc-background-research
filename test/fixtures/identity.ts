// Matcher fixtures for PRD.md sections 8 and 16.
import type { CandidateEvidence, SubjectInput } from "../../src/identity/matcher.js";

const ada = {
  fullName: "Ada Okonkwo",
  dateOfBirth: "1991-04-12",
  city: "Lagos",
  country: "NG",
} as const satisfies SubjectInput;

function person(
  id: string,
  overrides: Partial<CandidateEvidence> & Pick<CandidateEvidence, "names">,
  omit: readonly ("dateOfBirth" | "city" | "country")[] = [],
): CandidateEvidence {
  const built: CandidateEvidence = {
    id,
    dateOfBirth: ada.dateOfBirth,
    city: ada.city,
    country: ada.country,
    employers: [],
    handles: [],
    profileUrls: [],
    sourceIds: [`${id}-s1`],
    ...overrides,
  };
  const copy = { ...built };
  for (const key of omit) delete copy[key];
  return copy;
}

export const exactMatch = {
  subject: ada,
  candidates: [person("c1", { names: ["Ada Okonkwo"] })],
};

export const nicknameMatch = {
  subject: { ...ada, fullName: "William Okonkwo" },
  candidates: [person("c1", { names: ["Bill Okonkwo"] })],
};

export const sameNameOtherCity = {
  subject: ada,
  candidates: [
    person("c1", { names: ["Ada Okonkwo"] }),
    person("c2", { names: ["Ada Okonkwo"], city: "Nairobi", country: "KE", sourceIds: ["c2-s1"] }),
  ],
};

export const dobConflict = {
  subject: ada,
  candidates: [
    person("c1", {
      names: ["Ada Okonkwo"],
      dateOfBirth: "1985-01-01",
      employers: [
        { value: "Paystack", sourceId: "c1-s1" },
        { value: "Paystack", sourceId: "c1-s2" },
      ],
      sourceIds: ["c1-s1", "c1-s2"],
    }),
  ],
};

export const missingDob = {
  subject: { fullName: ada.fullName, city: ada.city, country: ada.country },
  candidates: [
    person(
      "c1",
      {
        names: ["Ada Okonkwo"],
        employers: [
          { value: "Paystack", sourceId: "c1-s1" },
          { value: "Paystack", sourceId: "c1-s2" },
        ],
        sourceIds: ["c1-s1", "c1-s2"],
      },
      ["dateOfBirth"],
    ),
  ],
};

export const corroborationBonus = {
  subject: ada,
  candidates: [
    person("c1", {
      names: ["Ada Okonkwo"],
      employers: [
        { value: "Paystack", sourceId: "c1-s1" },
        { value: "Paystack", sourceId: "c1-s2" },
      ],
      sourceIds: ["c1-s1", "c1-s2"],
    }),
  ],
};

export const ambiguousGap = {
  subject: ada,
  candidates: [
    person("c1", { names: ["Ada Okonkwo"] }, ["city"]),
    person("c2", { names: ["Ada Okonkwu"], sourceIds: ["c2-s1"] }),
  ],
};
