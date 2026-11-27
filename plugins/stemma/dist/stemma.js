// @bun
// packages/cli/src/main.ts
import { Database } from "bun:sqlite";
import { existsSync as existsSync3, readFileSync as readFileSync3, statSync as statSync2 } from "fs";
import { join as join3, resolve as resolve3 } from "path";
import { parseArgs } from "util";

// packages/records/src/json.ts
import { createHash } from "crypto";

class JsonUnreadable extends Error {
  problem;
  constructor(problem) {
    super(problem);
    this.problem = problem;
  }
}
function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new JsonUnreadable("not_utf8");
  }
}
var MAX_DEPTH = 100;
var LONE_SURROGATE = /\p{Surrogate}/u;
function emptyObject() {
  return Object.create(null);
}
function parseJson(text) {
  const source = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
  const forbidden = [];
  let at = 0;
  const fail = (problem = "syntax") => {
    throw new JsonUnreadable(problem);
  };
  const space = () => {
    while (at < source.length && ` 	
\r`.includes(source[at]))
      at++;
  };
  const string = () => {
    const start = at++;
    while (at < source.length && source[at] !== '"')
      at += source[at] === "\\" ? 2 : 1;
    if (source[at] !== '"')
      fail();
    at++;
    let decoded;
    try {
      decoded = JSON.parse(source.slice(start, at));
    } catch {
      return fail();
    }
    if (LONE_SURROGATE.test(decoded))
      fail("lone_surrogate");
    return decoded;
  };
  const value = (field, depth) => {
    if (depth > MAX_DEPTH)
      fail("too_deep");
    space();
    const first = source[at];
    if (first === '"')
      return string();
    if (first === "{" || first === "[") {
      const isObject = first === "{";
      const close = isObject ? "}" : "]";
      const object = emptyObject();
      const array = [];
      at++;
      space();
      if (source[at] === close) {
        at++;
        return isObject ? object : array;
      }
      for (;; ) {
        if (isObject) {
          space();
          if (source[at] !== '"')
            fail();
          const key = string();
          if (Object.hasOwn(object, key))
            fail("duplicate_key");
          space();
          if (source[at++] !== ":")
            fail();
          object[key] = value(`${field}/${key}`, depth + 1);
        } else
          array.push(value(`${field}/${array.length}`, depth + 1));
        space();
        const next = source[at++];
        if (next === close)
          return isObject ? object : array;
        if (next !== ",")
          fail();
      }
    }
    for (const [word, literal] of [["true", true], ["false", false], ["null", null]]) {
      if (source.startsWith(word, at)) {
        at += word.length;
        if (literal === null)
          forbidden.push({ field, problem: "null_value" });
        return literal;
      }
    }
    const number = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
    number.lastIndex = at;
    const match = number.exec(source) ?? fail();
    at += match[0].length;
    const parsed = Number(match[0]);
    if (match[1] || match[2] || !Number.isSafeInteger(parsed))
      forbidden.push({ field, problem: "number_not_integer" });
    return parsed;
  };
  const result = value("", 0);
  space();
  if (at !== source.length)
    fail();
  return { value: result, forbidden };
}
function compareCodePoints(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let i = 0;i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0) - right[i].codePointAt(0);
    if (difference !== 0)
      return difference;
  }
  return left.length - right.length;
}
var EXACT_STRINGS = /^\/legacy\/\d+\/(entry_text|fields\/\d+\/value)$|^\/blocks\/\d+\/text$/;
function write(value, indent, field) {
  if (typeof value === "string") {
    return JSON.stringify(EXACT_STRINGS.test(field) ? value : value.replace(/\r\n?/g, `
`));
  }
  if (value === null || typeof value !== "object")
    return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0)
      return "[]";
    const items = value.map((item, i) => inner + write(item, inner, `${field}/${i}`));
    return `[
${items.join(`,
`)}
${indent}]`;
  }
  const object = value;
  const keys = Object.keys(object).filter((k) => object[k] !== undefined).sort(compareCodePoints);
  if (keys.length === 0)
    return "{}";
  const entries = keys.map((k) => `${inner}${JSON.stringify(k)}: ${write(object[k], inner, `${field}/${k}`)}`);
  return `{
${entries.join(`,
`)}
${indent}}`;
}
function canonical(value) {
  return `${write(value, "", "")}
`;
}
function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
function digest(value) {
  return sha256(canonical(value));
}
function normalizeSentence(text) {
  return text.replace(/\p{White_Space}+/gu, " ").replace(/^ | $/g, "");
}

// packages/records/src/kinds.ts
var KINDS = Object.fromEntries([
  ["source", "src-", "sources"],
  ["agent", "agt-", "agents"],
  ["capture", "cap-", "captures"],
  ["extraction", "ext-", "extractions"],
  ["passage", "psg-", "passages"],
  ["note", "nte-", "notes"],
  ["claim", "clm-", "claims"],
  ["attestation", "att-", "attestations"],
  ["inference", "inf-", "inferences"],
  ["construct", "con-", "constructs"],
  ["method", "mth-", "methods"],
  ["chapter", "chp-", "chapters"],
  ["citation", "cit-", "citations"],
  ["intake_item", "itm-", "intake-items"],
  ["round_choice", "chc-", "round-choices"],
  ["review_comment", "rvc-", "review-comments"],
  ["place", "plc-", "places"],
  ["place_name", "pnm-", "place-names"],
  ["place_location", "loc-", "place-locations"],
  ["place_assertion", "pas-", "place-assertions"],
  ["search", "sch-", "searches"],
  ["decision", "dec-", "decisions"],
  ["support_record", "sup-", "support-records"],
  ["annotation", "ann-", "annotations"],
  ["resolution", "res-", "resolutions"],
  ["import_batch", "imp-", "imports"],
  ["confirmation", "cnf-", "confirmations"],
  ["plan", "pln-", "plans"],
  ["checkpoint_input", "ckp-", "checkpoint-inputs"],
  ["authorship_mark", "aum-", "authorship-marks"],
  ["ai_activity", "act-", "ai-activities"],
  ["voice_profile", "vop-", "voice-profiles"],
  ["voice_example", "vex-", "voice-examples"],
  ["governing_record", "gvr-", "governing-records"],
  ["governing_entry", "gve-", "governing-entries"],
  ["ai_role", "rol-", "ai-roles"],
  ["audit_finding", "aud-", "audit-findings"],
  ["review_baseline", "rbl-", "review-baselines"],
  ["image", "img-", "images"],
  ["conversion", "cnv-", "conversions"]
].map(([kind, prefix, directory]) => [kind, { prefix, directory }]));
var RECORD_SCHEMA = "stemma.record/0";
var PROJECT_SCHEMA = "stemma.project/0";
var PROJECT_FORMAT = 0;
function recordPath(kind, id) {
  return `records/${KINDS[kind].directory}/${id}.json`;
}
function isRecordId(kind, id) {
  const prefix = KINDS[kind]?.prefix;
  return prefix !== undefined && id.startsWith(prefix) && /^[0-9a-z]{8,40}$/.test(id.slice(prefix.length));
}
var FULLY_CHECKED_KINDS = new Set(["source", "citation", "agent", "capture", "extraction"]);

// packages/records/src/pages.ts
var ROMAN = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"]
];
function toRoman(value) {
  let left = value;
  let out = "";
  for (const [amount, letters] of ROMAN) {
    while (left >= amount) {
      out += letters;
      left -= amount;
    }
  }
  return out;
}
function fromRoman(text) {
  let value = 0;
  let at = 0;
  for (const [amount, letters] of ROMAN) {
    while (value < 5000 && text.startsWith(letters, at)) {
      value += amount;
      at += letters.length;
    }
  }
  return value > 0 && at === text.length && toRoman(value) === text ? value : undefined;
}
function firstNumber(style, label) {
  if (typeof label !== "string")
    return;
  if (style === "arabic")
    return /^[1-9]\d{0,6}$/.test(label) ? Number(label) : undefined;
  if (style === "roman_lower")
    return fromRoman(label);
  return label === label.toUpperCase() ? fromRoman(label.toLowerCase()) : undefined;
}
var isIndex = (value) => Number.isSafeInteger(value) && value >= 0;
var asObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
function checkPageSegments(pages) {
  if (!Array.isArray(pages))
    return [];
  const problems = [];
  const taken = [];
  pages.forEach((entry, index) => {
    const { first_index: first, last_index: last, style, first_label, labels, evidence } = asObject(entry);
    const add = (code) => problems.push({ code, index });
    if (!isIndex(first) || !isIndex(last) || last < first || taken.some(([a, b]) => first <= b && last >= a)) {
      add("bad_page_range");
      return;
    }
    taken.push([first, last]);
    if (style === "unnumbered") {
      if (first_label !== undefined || labels !== undefined)
        add("bad_page_labels");
      return;
    }
    if (style === "explicit") {
      if (!Array.isArray(labels) || labels.length !== last - first + 1 || first_label !== undefined)
        add("bad_page_labels");
    } else if (typeof style === "string" && (labels !== undefined || firstNumber(style, first_label) === undefined)) {
      add("bad_page_labels");
    }
    if (evidence === undefined)
      add("label_evidence_missing");
  });
  return problems;
}
function checkPageSpans(spans, length) {
  if (!Array.isArray(spans))
    return [];
  const bad = [];
  let page = -1;
  let end = 0;
  spans.forEach((entry, index) => {
    const span = asObject(entry);
    const ok = isIndex(span.page_index) && isIndex(span.start) && isIndex(span.end) && span.page_index > page && span.start >= end && span.end >= span.start && (length === undefined || span.end <= length);
    if (!ok)
      bad.push(index);
    else {
      page = span.page_index;
      end = span.end;
    }
  });
  return bad;
}
function pageLabels(segments) {
  const labels = new Map;
  for (const segment of segments) {
    if (segment.style === "unnumbered")
      continue;
    const start = segment.style === "explicit" ? 0 : firstNumber(segment.style, segment.first_label);
    if (start === undefined)
      continue;
    for (let i = segment.first_index;i <= segment.last_index; i++) {
      const offset = i - segment.first_index;
      const label = segment.style === "explicit" ? segment.labels?.[offset] : segment.style === "arabic" ? String(start + offset) : segment.style === "roman_lower" ? toRoman(start + offset) : toRoman(start + offset).toUpperCase();
      if (label !== undefined)
        labels.set(i, label);
    }
  }
  return labels;
}

// packages/records/src/schema.generated.ts
var TYPES = {
  Actor: {
    kind: {
      type: "string",
      required: true,
      values: [
        "person",
        "software",
        "model"
      ]
    },
    name: {
      type: "string",
      required: true
    },
    version: {
      type: "string"
    },
    prompt_version: {
      type: "string"
    }
  },
  Stamp: {
    at: {
      type: "date-time",
      required: true
    },
    by: {
      type: {
        value: "Actor"
      },
      required: true
    },
    activity: {
      type: "string"
    },
    import: {
      type: "string"
    }
  },
  Review: {
    state: {
      type: "string",
      required: true,
      values: [
        "unreviewed",
        "reviewed"
      ]
    },
    decided: {
      type: {
        value: "Stamp"
      }
    },
    content_sha256: {
      type: "string"
    },
    batch: {
      type: "string"
    }
  },
  ManuscriptOrigin: {
    import: {
      type: "string",
      required: true
    },
    document_position: {
      type: "string",
      required: true
    },
    text: {
      type: "string",
      required: true
    }
  },
  ItemBinding: {
    record: {
      type: "string",
      required: true
    },
    content_sha256: {
      type: "string",
      required: true
    }
  },
  TextComparison: {
    cited_text: {
      type: "string",
      required: true
    },
    stored_text: {
      type: "string",
      required: true
    },
    profile: {
      type: "string",
      required: true
    },
    extraction: {
      type: "string",
      required: true
    }
  },
  RecheckResult: {
    finding_key: {
      type: "string",
      required: true
    },
    check: {
      type: "string",
      required: true
    },
    outcome: {
      type: "string",
      required: true,
      values: [
        "pass",
        "fail",
        "unverifiable"
      ]
    }
  },
  Retirement: {
    stamp: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    reason: {
      type: "string",
      required: true
    },
    replaced_by: {
      type: "string"
    }
  },
  TextVariant: {
    kind: {
      type: "string",
      required: true,
      values: [
        "original",
        "transliteration",
        "translation"
      ]
    },
    value: {
      type: "string",
      required: true
    },
    lang: {
      type: "string"
    },
    scheme: {
      type: "string"
    }
  },
  Text: {
    value: {
      type: "string",
      required: true
    },
    lang: {
      type: "string"
    },
    variants: {
      type: {
        value: "TextVariant"
      },
      many: true
    }
  },
  NameParts: {
    family: {
      type: "string"
    },
    given: {
      type: "string"
    },
    particle: {
      type: "string"
    },
    suffix: {
      type: "string"
    },
    literal: {
      type: "string"
    }
  },
  PartialDate: {
    edtf: {
      type: "string"
    },
    calendar: {
      type: "string"
    },
    as_printed: {
      type: "string"
    },
    literal: {
      type: "string"
    }
  },
  DateEntry: {
    variable: {
      type: "string",
      required: true
    },
    date: {
      type: {
        value: "PartialDate"
      },
      required: true
    }
  },
  BibField: {
    name: {
      type: "string",
      required: true
    },
    value: {
      type: {
        value: "Text"
      },
      required: true
    }
  },
  Contribution: {
    lid: {
      type: "string",
      required: true
    },
    role: {
      type: "string",
      required: true
    },
    agent: {
      type: "string"
    },
    as_printed: {
      type: {
        value: "NameParts"
      }
    }
  },
  SourceRelation: {
    lid: {
      type: "string",
      required: true
    },
    type: {
      type: "string",
      required: true,
      values: [
        "part_of",
        "edition_of",
        "translation_of",
        "reprint_of",
        "revision_of",
        "facsimile_of",
        "reviews",
        "instance_of"
      ]
    },
    target: {
      type: "string",
      required: true
    }
  },
  Identifier: {
    scheme: {
      type: "string",
      required: true
    },
    value: {
      type: "string",
      required: true
    },
    asserted_by: {
      type: "string"
    }
  },
  Extent: {
    label: {
      type: "string",
      required: true
    },
    first: {
      type: "string",
      required: true
    },
    last: {
      type: "string",
      required: true
    }
  },
  Rights: {
    unpublished: {
      type: "boolean"
    },
    community_restricted: {
      type: "boolean"
    },
    license: {
      type: "string"
    },
    permission_note: {
      type: "string"
    }
  },
  Locator: {
    label: {
      type: "string",
      required: true
    },
    value: {
      type: "string",
      required: true
    },
    end: {
      type: "string"
    },
    page_index: {
      type: "integer"
    }
  },
  IndirectQuote: {
    source: {
      type: "string",
      required: true
    },
    locator: {
      type: {
        value: "Locator"
      }
    }
  },
  QuoteSelector: {
    exact: {
      type: "string",
      required: true
    },
    prefix: {
      type: "string"
    },
    suffix: {
      type: "string"
    }
  },
  PositionSelector: {
    start: {
      type: "integer",
      required: true
    },
    end: {
      type: "integer",
      required: true
    }
  },
  Region: {
    page_index: {
      type: "integer",
      required: true
    },
    x: {
      type: "string",
      required: true
    },
    y: {
      type: "string",
      required: true
    },
    width: {
      type: "string",
      required: true
    },
    height: {
      type: "string",
      required: true
    }
  },
  PageSegment: {
    first_index: {
      type: "integer",
      required: true
    },
    last_index: {
      type: "integer",
      required: true
    },
    style: {
      type: "string",
      required: true,
      values: [
        "arabic",
        "roman_lower",
        "roman_upper",
        "explicit",
        "unnumbered"
      ]
    },
    first_label: {
      type: "string"
    },
    labels: {
      type: "string",
      many: true
    },
    evidence: {
      type: "string",
      values: [
        "printed_sequence",
        "embedded_label",
        "author_statement"
      ]
    }
  },
  ToolRef: {
    name: {
      type: "string",
      required: true
    },
    version: {
      type: "string",
      required: true
    }
  },
  ExtractionQuality: {
    method: {
      type: "string",
      required: true,
      values: [
        "text_layer",
        "ocr",
        "manual",
        "born_text"
      ]
    },
    level: {
      type: "string",
      required: true,
      values: [
        "good",
        "partial",
        "poor",
        "unassessed"
      ]
    },
    scripts: {
      type: "string",
      many: true
    },
    note: {
      type: "string"
    }
  },
  SentenceBinding: {
    text: {
      type: "string",
      required: true
    },
    sha256: {
      type: "string",
      required: true
    }
  },
  SourceBinding: {
    source: {
      type: "string",
      required: true
    },
    record_sha256: {
      type: "string",
      required: true
    },
    capture_sha256: {
      type: "string",
      many: true
    }
  },
  LegacyField: {
    native_path: {
      type: "string",
      required: true
    },
    value: {
      type: "string"
    },
    encoding: {
      type: "string",
      required: true,
      values: [
        "text",
        "json",
        "tex",
        "raw"
      ]
    },
    ordinal: {
      type: "integer"
    },
    mapped_to: {
      type: "string"
    },
    mapped_sha256: {
      type: "string"
    },
    value_blob_sha256: {
      type: "string"
    }
  },
  LegacyEntry: {
    import: {
      type: "string",
      required: true
    },
    native_key: {
      type: "string"
    },
    native_type: {
      type: "string"
    },
    ordinal: {
      type: "integer",
      required: true
    },
    entry_text: {
      type: "string"
    },
    fields: {
      type: {
        value: "LegacyField"
      },
      many: true
    },
    entry_text_blob_sha256: {
      type: "string"
    }
  },
  LegacyBlock: {
    kind: {
      type: "string",
      required: true,
      values: [
        "comment",
        "preamble",
        "string_definition",
        "header",
        "other"
      ]
    },
    text: {
      type: "string"
    },
    ordinal: {
      type: "integer",
      required: true
    },
    text_blob_sha256: {
      type: "string"
    }
  },
  LossItem: {
    path: {
      type: "string",
      required: true
    },
    class: {
      type: "string",
      required: true,
      values: [
        "unrepresented",
        "approximated",
        "representation_change"
      ]
    },
    note: {
      type: "string"
    }
  },
  ConstructRelation: {
    lid: {
      type: "string",
      required: true
    },
    type: {
      type: "string",
      required: true
    },
    target: {
      type: "string",
      required: true
    }
  },
  Position: {
    lon: {
      type: "string",
      required: true
    },
    lat: {
      type: "string",
      required: true
    }
  },
  Geometry: {
    type: {
      type: "string",
      required: true,
      values: [
        "Point",
        "Polygon"
      ]
    },
    positions: {
      type: {
        value: "Position"
      },
      required: true,
      many: true
    }
  },
  Sensitivity: {
    class: {
      type: "string",
      required: true,
      values: [
        "public",
        "restricted"
      ]
    },
    release: {
      type: "string",
      required: true,
      values: [
        "exact",
        "area",
        "withhold"
      ]
    },
    decided: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    reason: {
      type: "string"
    },
    authority: {
      type: "string"
    }
  },
  GazetteerMatch: {
    gazetteer: {
      type: "string",
      required: true
    },
    identifier: {
      type: "string",
      required: true
    },
    match: {
      type: "string",
      required: true,
      values: [
        "close",
        "exact"
      ]
    },
    retrieved_at: {
      type: "date-time"
    },
    license: {
      type: "string"
    }
  },
  CitationStyle: {
    id: {
      type: "string",
      required: true
    },
    sha256: {
      type: "string",
      required: true
    },
    locale: {
      type: "string",
      required: true
    }
  },
  Source: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "source"
      ]
    },
    citation_key: {
      type: "string"
    },
    key_aliases: {
      type: "string",
      many: true
    },
    type: {
      type: "string"
    },
    subtype: {
      type: "string"
    },
    title: {
      type: {
        value: "Text"
      }
    },
    contributions: {
      type: {
        value: "Contribution"
      },
      many: true
    },
    issued: {
      type: {
        value: "PartialDate"
      }
    },
    dates: {
      type: {
        value: "DateEntry"
      },
      many: true
    },
    bib: {
      type: {
        value: "BibField"
      },
      many: true
    },
    identifiers: {
      type: {
        value: "Identifier"
      },
      many: true
    },
    relations: {
      type: {
        value: "SourceRelation"
      },
      many: true
    },
    extents: {
      type: {
        value: "Extent"
      },
      many: true
    },
    locator_label: {
      type: "string"
    },
    sort_key: {
      type: "string"
    },
    bibliography_group: {
      type: "string"
    },
    rights: {
      type: {
        value: "Rights"
      }
    },
    intake: {
      type: "string",
      required: true,
      values: [
        "raw",
        "parsed",
        "resolved",
        "confirmed"
      ]
    },
    admission: {
      type: "string",
      required: true,
      values: [
        "candidate",
        "admitted",
        "rejected"
      ]
    },
    as_found: {
      type: "string"
    }
  },
  Agent: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "agent"
      ]
    },
    name: {
      type: {
        value: "NameParts"
      },
      required: true
    },
    variants: {
      type: {
        value: "TextVariant"
      },
      many: true
    },
    identifiers: {
      type: {
        value: "Identifier"
      },
      many: true
    },
    sort_key: {
      type: "string"
    }
  },
  Capture: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "capture"
      ]
    },
    source: {
      type: "string",
      required: true
    },
    sha256: {
      type: "string",
      required: true
    },
    size: {
      type: "integer",
      required: true
    },
    media_type: {
      type: "string",
      required: true
    },
    origin: {
      type: "string",
      required: true
    },
    acquired_at: {
      type: "date-time",
      required: true
    },
    source_version: {
      type: "string"
    },
    admitted_by: {
      type: {
        value: "Actor"
      },
      required: true
    },
    url: {
      type: "string"
    },
    shelfmark: {
      type: "string"
    }
  },
  Extraction: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "extraction"
      ]
    },
    capture: {
      type: "string",
      required: true
    },
    capture_sha256: {
      type: "string",
      required: true
    },
    tool: {
      type: {
        value: "ToolRef"
      },
      required: true
    },
    normalization_profile: {
      type: "string",
      required: true
    },
    text_sha256: {
      type: "string",
      required: true
    },
    text_size: {
      type: "integer",
      required: true
    },
    pages: {
      type: {
        value: "PageSegment"
      },
      many: true
    },
    quality: {
      type: {
        value: "ExtractionQuality"
      },
      required: true
    },
    page_spans: {
      type: {
        value: "PageSpan"
      },
      many: true
    },
    metadata: {
      type: {
        value: "HeldMetadata"
      }
    }
  },
  Passage: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "passage"
      ]
    },
    source: {
      type: "string",
      required: true
    },
    capture: {
      type: "string",
      required: true
    },
    extraction: {
      type: "string",
      required: true
    },
    text_sha256: {
      type: "string",
      required: true
    },
    quote: {
      type: {
        value: "QuoteSelector"
      },
      required: true
    },
    position: {
      type: {
        value: "PositionSelector"
      }
    },
    region: {
      type: {
        value: "Region"
      }
    },
    locator: {
      type: {
        value: "Locator"
      },
      required: true
    },
    quoted_from: {
      type: {
        value: "IndirectQuote"
      }
    },
    source_record_sha256: {
      type: "string"
    }
  },
  Note: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "note"
      ]
    },
    type: {
      type: "string",
      required: true,
      values: [
        "extract",
        "paraphrase",
        "comment"
      ]
    },
    source: {
      type: "string",
      required: true
    },
    passages: {
      type: "string",
      many: true
    },
    body: {
      type: "string",
      required: true
    },
    locator: {
      type: {
        value: "Locator"
      }
    },
    review: {
      type: {
        value: "Review"
      },
      required: true
    }
  },
  Claim: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "claim"
      ]
    },
    text: {
      type: "string",
      required: true
    },
    role: {
      type: "string",
      required: true,
      values: [
        "thesis",
        "claim",
        "rival_reading",
        "objection"
      ]
    },
    confidence: {
      type: "string",
      values: [
        "low",
        "medium",
        "high"
      ]
    },
    reason: {
      type: "string"
    },
    chapters: {
      type: "string",
      many: true
    },
    constructs: {
      type: "string",
      many: true
    },
    methods: {
      type: "string",
      many: true
    },
    origins: {
      type: {
        value: "ManuscriptOrigin"
      },
      many: true
    },
    review: {
      type: {
        value: "Review"
      },
      required: true
    },
    own: {
      type: "boolean"
    }
  },
  Attestation: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "attestation"
      ]
    },
    claim: {
      type: "string",
      required: true
    },
    evidence: {
      type: "string",
      required: true
    },
    stance: {
      type: "string",
      required: true,
      values: [
        "supports",
        "partly_supports",
        "contradicts",
        "qualifies",
        "context"
      ]
    },
    basis: {
      type: "string"
    },
    review: {
      type: {
        value: "Review"
      },
      required: true
    }
  },
  Inference: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "inference"
      ]
    },
    premises: {
      type: "string",
      required: true,
      many: true
    },
    conclusion: {
      type: "string",
      required: true
    },
    relation: {
      type: "string",
      required: true,
      values: [
        "supports",
        "attacks",
        "undercuts"
      ]
    },
    warrant: {
      type: "string"
    },
    review: {
      type: {
        value: "Review"
      },
      required: true
    }
  },
  Construct: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "construct"
      ]
    },
    label: {
      type: {
        value: "Text"
      },
      required: true
    },
    ownership: {
      type: "string",
      values: [
        "author",
        "borrowed"
      ]
    },
    definition: {
      type: "string"
    },
    originators: {
      type: "string",
      many: true
    },
    origin_source: {
      type: "string"
    },
    origin_passage: {
      type: "string"
    },
    chapters: {
      type: "string",
      many: true
    },
    relations: {
      type: {
        value: "ConstructRelation"
      },
      many: true
    },
    origins: {
      type: {
        value: "ManuscriptOrigin"
      },
      many: true
    },
    review: {
      type: {
        value: "Review"
      },
      required: true
    }
  },
  Method: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "method"
      ]
    },
    statement: {
      type: "string",
      required: true
    },
    applies_to: {
      type: "string"
    },
    draws_on: {
      type: "string",
      many: true
    },
    origins: {
      type: {
        value: "ManuscriptOrigin"
      },
      many: true
    },
    review: {
      type: {
        value: "Review"
      },
      required: true
    }
  },
  Chapter: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "chapter"
      ]
    },
    title: {
      type: "string",
      required: true
    },
    order: {
      type: "integer",
      required: true
    },
    matter: {
      type: "string",
      required: true,
      values: [
        "front",
        "body",
        "back"
      ]
    },
    manuscript_path: {
      type: "string"
    }
  },
  Citation: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "citation"
      ]
    },
    chapter: {
      type: "string"
    },
    key: {
      type: "string"
    },
    source: {
      type: "string"
    },
    locator: {
      type: {
        value: "Locator"
      }
    },
    quotation: {
      type: "string"
    },
    sentence: {
      type: {
        value: "SentenceBinding"
      },
      required: true
    },
    claims: {
      type: "string",
      many: true
    },
    as_found: {
      type: "string"
    },
    document_position: {
      type: "string"
    },
    intake: {
      type: "string",
      required: true,
      values: [
        "raw",
        "parsed",
        "resolved",
        "confirmed"
      ]
    }
  },
  Place: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "place"
      ]
    },
    label: {
      type: "string",
      required: true
    },
    feature_type: {
      type: "string"
    },
    gazetteer: {
      type: {
        value: "GazetteerMatch"
      },
      many: true
    },
    review: {
      type: {
        value: "Review"
      }
    }
  },
  PlaceName: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "place_name"
      ]
    },
    place: {
      type: "string",
      required: true
    },
    name: {
      type: {
        value: "Text"
      },
      required: true
    },
    period: {
      type: {
        value: "PartialDate"
      }
    },
    evidence: {
      type: "string",
      many: true
    },
    review: {
      type: {
        value: "Review"
      }
    }
  },
  PlaceLocation: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "place_location"
      ]
    },
    place: {
      type: "string",
      required: true
    },
    sensitivity: {
      type: {
        value: "Sensitivity"
      }
    },
    geometry: {
      type: {
        value: "Geometry"
      }
    },
    uncertainty_m: {
      type: "integer"
    },
    certainty: {
      type: "string",
      required: true,
      values: [
        "certain",
        "probable",
        "possible",
        "uncertain"
      ]
    },
    method: {
      type: "string",
      required: true,
      values: [
        "surveyed",
        "stated_by_source",
        "gazetteer",
        "inferred"
      ]
    },
    period: {
      type: {
        value: "PartialDate"
      }
    },
    evidence: {
      type: "string",
      required: true,
      many: true
    },
    review: {
      type: {
        value: "Review"
      },
      required: true
    }
  },
  PlaceAssertion: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "place_assertion"
      ]
    },
    subject: {
      type: "string",
      required: true
    },
    relation: {
      type: "string",
      required: true,
      values: [
        "located_in",
        "near",
        "identified_with",
        "same_event_at",
        "concerns"
      ]
    },
    place: {
      type: "string",
      required: true
    },
    polarity: {
      type: "string",
      required: true,
      values: [
        "affirms",
        "denies"
      ]
    },
    certainty: {
      type: "string",
      required: true,
      values: [
        "certain",
        "probable",
        "possible",
        "uncertain"
      ]
    },
    evidence: {
      type: "string",
      required: true,
      many: true
    },
    review: {
      type: {
        value: "Review"
      },
      required: true
    }
  },
  Search: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "search"
      ]
    },
    query: {
      type: "string",
      required: true
    },
    scope: {
      type: "string",
      required: true,
      values: [
        "corpus",
        "external"
      ]
    },
    tool: {
      type: "string"
    },
    limits: {
      type: "string"
    },
    languages: {
      type: "string",
      many: true
    },
    performed: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    candidates: {
      type: "string",
      many: true
    },
    gaps: {
      type: "string"
    },
    run_by: {
      type: "string",
      values: [
        "command",
        "agent"
      ]
    },
    locations: {
      type: {
        value: "SearchLocation"
      },
      many: true
    },
    periods: {
      type: "string",
      many: true
    },
    regions: {
      type: "string",
      many: true
    },
    candidate_origins: {
      type: {
        value: "CandidateOrigin"
      },
      many: true
    }
  },
  Decision: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "decision"
      ]
    },
    source: {
      type: "string",
      required: true
    },
    search: {
      type: "string"
    },
    outcome: {
      type: "string",
      required: true,
      values: [
        "admitted",
        "rejected"
      ]
    },
    reason: {
      type: "string"
    },
    decided: {
      type: {
        value: "Stamp"
      },
      required: true
    }
  },
  SupportRecord: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "support_record"
      ]
    },
    claim: {
      type: "string",
      required: true
    },
    passage: {
      type: "string",
      required: true
    },
    claim_text: {
      type: "string",
      required: true
    },
    claim_sha256: {
      type: "string",
      required: true
    },
    passage_text: {
      type: "string",
      required: true
    },
    passage_sha256: {
      type: "string",
      required: true
    },
    capture_sha256: {
      type: "string",
      required: true
    },
    model: {
      type: "string",
      required: true
    },
    model_version: {
      type: "string"
    },
    prompt_id: {
      type: "string",
      required: true
    },
    prompt_version: {
      type: "string",
      required: true
    },
    separate_context: {
      type: "boolean",
      required: true
    },
    verdict: {
      type: "string",
      required: true,
      values: [
        "supported",
        "partly_supported",
        "unsupported"
      ]
    },
    quoted: {
      type: "string",
      required: true
    },
    problems: {
      type: "string",
      many: true,
      values: [
        "goes_beyond",
        "overstates",
        "reverses"
      ]
    },
    explanation: {
      type: "string"
    },
    checked: {
      type: {
        value: "Stamp"
      },
      required: true
    }
  },
  Annotation: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "annotation"
      ]
    },
    effect: {
      type: "string",
      required: true,
      values: [
        "explain",
        "dismiss"
      ]
    },
    check: {
      type: "string",
      required: true
    },
    finding_key: {
      type: "string",
      required: true
    },
    sentence: {
      type: {
        value: "SentenceBinding"
      }
    },
    source: {
      type: {
        value: "SourceBinding"
      }
    },
    item: {
      type: {
        value: "ItemBinding"
      }
    },
    compared: {
      type: {
        value: "TextComparison"
      }
    },
    reason: {
      type: "string",
      required: true
    },
    written: {
      type: {
        value: "Stamp"
      },
      required: true
    }
  },
  IntakeItem: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "intake_item"
      ]
    },
    import: {
      type: "string",
      required: true
    },
    category: {
      type: "string",
      required: true,
      values: [
        "ambiguous_reference",
        "unclassified_note",
        "unread_content",
        "duplicate_candidate",
        "original_changed"
      ]
    },
    reason: {
      type: "string",
      required: true
    },
    document_position: {
      type: "string"
    },
    as_found: {
      type: "string"
    },
    candidates: {
      type: "string",
      many: true
    },
    citation: {
      type: "string"
    }
  },
  RoundChoice: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "round_choice"
      ]
    },
    action: {
      type: "string",
      required: true,
      values: [
        "remove",
        "repoint",
        "replace",
        "bind",
        "close"
      ]
    },
    citation: {
      type: "string"
    },
    item: {
      type: "string"
    },
    finding_key: {
      type: "string"
    },
    previous_source: {
      type: "string"
    },
    new_source: {
      type: "string"
    },
    claims: {
      type: "string",
      many: true
    },
    chosen: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    report_sha256: {
      type: "string"
    },
    recheck: {
      type: {
        value: "RecheckResult"
      },
      many: true
    }
  },
  ReviewComment: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "review_comment"
      ]
    },
    claim: {
      type: "string",
      required: true
    },
    claim_sha256: {
      type: "string",
      required: true
    },
    comment_id: {
      type: "string",
      required: true
    },
    text: {
      type: "string",
      required: true
    },
    reviewer: {
      type: "string"
    },
    commented_at: {
      type: "date-time",
      required: true
    },
    file_sha256: {
      type: "string",
      required: true
    },
    package_corpus_digest: {
      type: "string",
      required: true
    },
    handled: {
      type: "string",
      required: true,
      values: [
        "open",
        "addressed",
        "declined"
      ]
    }
  },
  Resolution: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "resolution"
      ]
    },
    source: {
      type: "string",
      required: true
    },
    resolver: {
      type: "string",
      required: true
    },
    query: {
      type: "string",
      required: true
    },
    queried_at: {
      type: "date-time",
      required: true
    },
    outcome: {
      type: "string",
      required: true,
      values: [
        "found",
        "not_found",
        "error"
      ]
    },
    response_sha256: {
      type: "string"
    },
    fields: {
      type: {
        value: "BibField"
      },
      many: true
    }
  },
  ImportBatch: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "import_batch"
      ]
    },
    format: {
      type: "string",
      required: true,
      values: [
        "csl_json",
        "biblatex",
        "ris",
        "docx"
      ]
    },
    codec: {
      type: {
        value: "ToolRef"
      },
      required: true
    },
    original_name: {
      type: "string",
      required: true
    },
    original_sha256: {
      type: "string",
      required: true
    },
    size: {
      type: "integer",
      required: true
    },
    entry_count: {
      type: "integer",
      required: true
    },
    blocks: {
      type: {
        value: "LegacyBlock"
      },
      many: true
    },
    losses: {
      type: {
        value: "LossItem"
      },
      many: true
    }
  },
  Project: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.project/0"
      ]
    },
    project_id: {
      type: "string",
      required: true
    },
    format: {
      type: "integer",
      required: true
    },
    citation_style: {
      type: {
        value: "CitationStyle"
      }
    },
    trim_size: {
      type: "string",
      values: [
        "6x9in",
        "5.5x8.5in",
        "a5"
      ]
    },
    bibliography_include: {
      type: "string",
      many: true
    },
    audience: {
      type: "string"
    },
    scope: {
      type: "string"
    },
    tools: {
      type: {
        value: "ToolRef"
      },
      many: true
    },
    book_style: {
      type: {
        value: "BookStyle"
      }
    },
    persona: {
      type: {
        value: "PersonaSettings"
      }
    },
    voice_profile: {
      type: "string"
    }
  },
  PageSpan: {
    page_index: {
      type: "integer",
      required: true
    },
    start: {
      type: "integer",
      required: true
    },
    end: {
      type: "integer",
      required: true
    }
  },
  HeldMetadata: {
    title: {
      type: "string"
    },
    contributors: {
      type: "string",
      many: true
    },
    issued: {
      type: "string"
    },
    venue: {
      type: "string"
    }
  },
  CandidateOrigin: {
    source: {
      type: "string",
      required: true
    },
    location: {
      type: "string",
      required: true
    },
    supplied_fields: {
      type: "string",
      many: true
    }
  },
  SearchLocation: {
    name: {
      type: "string",
      required: true
    },
    status: {
      type: "string",
      required: true,
      values: [
        "searched",
        "failed",
        "not_run"
      ]
    }
  },
  BookStyle: {
    style: {
      type: "string"
    },
    fonts: {
      type: "string",
      many: true
    },
    bleed: {
      type: "string"
    },
    print_threshold_ppi: {
      type: "integer"
    }
  },
  PersonaSettings: {
    name: {
      type: "string"
    },
    explanation_level: {
      type: "string"
    },
    checkpoints: {
      type: "integer"
    }
  },
  Confirmation: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "confirmation"
      ]
    },
    source: {
      type: "string",
      required: true
    },
    capture: {
      type: "string",
      required: true
    },
    page_indexes: {
      type: "integer",
      required: true,
      many: true
    },
    page_basis: {
      type: "string",
      required: true,
      values: [
        "title_page",
        "equivalent"
      ]
    },
    fields: {
      type: "string",
      required: true,
      many: true,
      values: [
        "contributions",
        "title",
        "issued",
        "venue"
      ]
    },
    source_record_sha256: {
      type: "string",
      required: true
    },
    capture_sha256: {
      type: "string",
      required: true
    },
    note: {
      type: "string"
    },
    confirmed: {
      type: {
        value: "Stamp"
      },
      required: true
    }
  },
  Plan: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "plan"
      ]
    },
    plan_type: {
      type: "string",
      required: true,
      values: [
        "outline",
        "chapter_spec"
      ]
    },
    chapter: {
      type: "string"
    },
    body: {
      type: "string",
      required: true
    },
    claims: {
      type: "string",
      many: true
    },
    constructs: {
      type: "string",
      many: true
    },
    methods: {
      type: "string",
      many: true
    },
    review: {
      type: {
        value: "Review"
      },
      required: true
    }
  },
  CheckpointInput: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "checkpoint_input"
      ]
    },
    chapter: {
      type: "string",
      required: true
    },
    checkpoint: {
      type: "string",
      required: true
    },
    input: {
      type: "string",
      required: true
    },
    given: {
      type: {
        value: "Stamp"
      },
      required: true
    }
  },
  AuthorshipMark: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "authorship_mark"
      ]
    },
    chapter: {
      type: "string",
      required: true
    },
    text: {
      type: "string",
      required: true
    },
    text_sha256: {
      type: "string",
      required: true
    },
    authorship: {
      type: "string",
      required: true,
      values: [
        "ai_drafted",
        "human_written",
        "edited"
      ]
    },
    version: {
      type: "string",
      required: true
    },
    marked: {
      type: {
        value: "Stamp"
      },
      required: true
    }
  },
  AiActivity: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "ai_activity"
      ]
    },
    mode: {
      type: "string",
      required: true
    },
    role: {
      type: "string"
    },
    model: {
      type: "string",
      required: true
    },
    model_version: {
      type: "string"
    },
    prompt_version: {
      type: "string"
    },
    chapter: {
      type: "string"
    },
    records: {
      type: "string",
      many: true
    },
    voice_profile: {
      type: "string"
    },
    summary: {
      type: "string",
      required: true
    },
    performed: {
      type: {
        value: "Stamp"
      },
      required: true
    }
  },
  GuidanceEntry: {
    lid: {
      type: "string",
      required: true
    },
    overrides: {
      type: "string"
    },
    text: {
      type: "string",
      required: true
    }
  },
  VoiceProfile: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "voice_profile"
      ]
    },
    base_id: {
      type: "string",
      required: true
    },
    base_sha256: {
      type: "string",
      required: true
    },
    entries: {
      type: {
        value: "GuidanceEntry"
      },
      many: true
    },
    model: {
      type: "string"
    },
    prompt_version: {
      type: "string"
    },
    review: {
      type: {
        value: "Review"
      },
      required: true
    }
  },
  VoiceExample: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "voice_example"
      ]
    },
    profile: {
      type: "string",
      required: true
    },
    text: {
      type: "string",
      required: true
    },
    provided: {
      type: {
        value: "Stamp"
      },
      required: true
    }
  },
  GoverningRecord: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "governing_record"
      ]
    },
    record_type: {
      type: "string",
      required: true,
      values: [
        "changelog",
        "errata",
        "decision_log",
        "register"
      ]
    },
    name: {
      type: "string",
      required: true
    },
    identity: {
      type: "string"
    },
    path: {
      type: "string"
    },
    depends_on: {
      type: "string",
      many: true
    }
  },
  GoverningEntry: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "governing_entry"
      ]
    },
    record: {
      type: "string",
      required: true
    },
    text: {
      type: "string",
      required: true
    },
    date: {
      type: "string"
    },
    version: {
      type: "string"
    },
    cause: {
      type: "string"
    },
    fix: {
      type: "string"
    },
    chapter: {
      type: "string"
    }
  },
  AiRole: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "ai_role"
      ]
    },
    name: {
      type: "string",
      required: true
    },
    reads: {
      type: "string",
      many: true
    },
    writes: {
      type: "string",
      many: true
    },
    checks: {
      type: "string",
      many: true
    }
  },
  AuditFinding: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "audit_finding"
      ]
    },
    chapter: {
      type: "string",
      required: true
    },
    claim: {
      type: "string"
    },
    stage: {
      type: "string",
      required: true,
      values: [
        "rival_reading",
        "citation_repair"
      ]
    },
    status: {
      type: "string",
      required: true,
      values: [
        "confirmed",
        "suspected"
      ]
    },
    text: {
      type: "string",
      required: true
    },
    unexamined_sources: {
      type: "string",
      many: true
    },
    found: {
      type: {
        value: "Stamp"
      },
      required: true
    }
  },
  InputDigest: {
    input: {
      type: "string",
      required: true
    },
    sha256: {
      type: "string",
      required: true
    }
  },
  ReviewBaseline: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "review_baseline"
      ]
    },
    inputs: {
      type: {
        value: "InputDigest"
      },
      required: true,
      many: true
    },
    taken: {
      type: {
        value: "Stamp"
      },
      required: true
    }
  },
  Image: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "image"
      ]
    },
    blob_sha256: {
      type: "string",
      required: true
    },
    figure_id: {
      type: "string"
    },
    source: {
      type: "string"
    },
    credit: {
      type: "string"
    },
    rights: {
      type: {
        value: "Rights"
      }
    },
    permission: {
      type: "string"
    },
    caption: {
      type: "string"
    },
    alt: {
      type: "string"
    }
  },
  Conversion: {
    schema: {
      type: "string",
      required: true,
      values: [
        "stemma.record/0"
      ]
    },
    id: {
      type: "string",
      required: true
    },
    created: {
      type: {
        value: "Stamp"
      },
      required: true
    },
    changed: {
      type: {
        value: "Stamp"
      }
    },
    retired: {
      type: {
        value: "Retirement"
      }
    },
    legacy: {
      type: {
        value: "LegacyEntry"
      },
      many: true
    },
    kind: {
      type: "string",
      required: true,
      values: [
        "conversion"
      ]
    },
    input_sha256: {
      type: "string",
      required: true
    },
    output_sha256: {
      type: "string",
      required: true
    },
    tool: {
      type: {
        value: "ToolRef"
      },
      required: true
    },
    losses: {
      type: "string",
      many: true
    },
    performed: {
      type: {
        value: "Stamp"
      },
      required: true
    }
  }
};
var KIND_TYPES = {
  source: "Source",
  agent: "Agent",
  capture: "Capture",
  extraction: "Extraction",
  passage: "Passage",
  note: "Note",
  claim: "Claim",
  attestation: "Attestation",
  inference: "Inference",
  construct: "Construct",
  method: "Method",
  chapter: "Chapter",
  citation: "Citation",
  place: "Place",
  place_name: "PlaceName",
  place_location: "PlaceLocation",
  place_assertion: "PlaceAssertion",
  search: "Search",
  decision: "Decision",
  support_record: "SupportRecord",
  annotation: "Annotation",
  intake_item: "IntakeItem",
  round_choice: "RoundChoice",
  review_comment: "ReviewComment",
  resolution: "Resolution",
  import_batch: "ImportBatch",
  confirmation: "Confirmation",
  plan: "Plan",
  checkpoint_input: "CheckpointInput",
  authorship_mark: "AuthorshipMark",
  ai_activity: "AiActivity",
  voice_profile: "VoiceProfile",
  voice_example: "VoiceExample",
  governing_record: "GoverningRecord",
  governing_entry: "GoverningEntry",
  ai_role: "AiRole",
  audit_finding: "AuditFinding",
  review_baseline: "ReviewBaseline",
  image: "Image",
  conversion: "Conversion"
};
var REFERENCES = {
  "source.created.import": [
    "import_batch"
  ],
  "source.changed.import": [
    "import_batch"
  ],
  "source.retired.stamp.import": [
    "import_batch"
  ],
  "source.legacy.import": [
    "import_batch"
  ],
  "source.contributions.agent": [
    "agent"
  ],
  "source.relations.target": [
    "source"
  ],
  "agent.created.import": [
    "import_batch"
  ],
  "agent.changed.import": [
    "import_batch"
  ],
  "agent.retired.stamp.import": [
    "import_batch"
  ],
  "agent.legacy.import": [
    "import_batch"
  ],
  "capture.created.import": [
    "import_batch"
  ],
  "capture.changed.import": [
    "import_batch"
  ],
  "capture.retired.stamp.import": [
    "import_batch"
  ],
  "capture.legacy.import": [
    "import_batch"
  ],
  "capture.source": [
    "source"
  ],
  "extraction.created.import": [
    "import_batch"
  ],
  "extraction.changed.import": [
    "import_batch"
  ],
  "extraction.retired.stamp.import": [
    "import_batch"
  ],
  "extraction.legacy.import": [
    "import_batch"
  ],
  "extraction.capture": [
    "capture"
  ],
  "passage.created.import": [
    "import_batch"
  ],
  "passage.changed.import": [
    "import_batch"
  ],
  "passage.retired.stamp.import": [
    "import_batch"
  ],
  "passage.legacy.import": [
    "import_batch"
  ],
  "passage.source": [
    "source"
  ],
  "passage.capture": [
    "capture"
  ],
  "passage.extraction": [
    "extraction"
  ],
  "passage.quoted_from.source": [
    "source"
  ],
  "note.created.import": [
    "import_batch"
  ],
  "note.changed.import": [
    "import_batch"
  ],
  "note.retired.stamp.import": [
    "import_batch"
  ],
  "note.legacy.import": [
    "import_batch"
  ],
  "note.source": [
    "source"
  ],
  "note.passages": [
    "passage"
  ],
  "note.review.decided.import": [
    "import_batch"
  ],
  "claim.created.import": [
    "import_batch"
  ],
  "claim.changed.import": [
    "import_batch"
  ],
  "claim.retired.stamp.import": [
    "import_batch"
  ],
  "claim.legacy.import": [
    "import_batch"
  ],
  "claim.chapters": [
    "chapter"
  ],
  "claim.constructs": [
    "construct"
  ],
  "claim.methods": [
    "method"
  ],
  "claim.origins.import": [
    "import_batch"
  ],
  "claim.review.decided.import": [
    "import_batch"
  ],
  "attestation.created.import": [
    "import_batch"
  ],
  "attestation.changed.import": [
    "import_batch"
  ],
  "attestation.retired.stamp.import": [
    "import_batch"
  ],
  "attestation.legacy.import": [
    "import_batch"
  ],
  "attestation.claim": [
    "claim"
  ],
  "attestation.evidence": [
    "note",
    "passage"
  ],
  "attestation.review.decided.import": [
    "import_batch"
  ],
  "inference.created.import": [
    "import_batch"
  ],
  "inference.changed.import": [
    "import_batch"
  ],
  "inference.retired.stamp.import": [
    "import_batch"
  ],
  "inference.legacy.import": [
    "import_batch"
  ],
  "inference.premises": [
    "claim",
    "attestation"
  ],
  "inference.conclusion": [
    "claim",
    "inference"
  ],
  "inference.review.decided.import": [
    "import_batch"
  ],
  "construct.created.import": [
    "import_batch"
  ],
  "construct.changed.import": [
    "import_batch"
  ],
  "construct.retired.stamp.import": [
    "import_batch"
  ],
  "construct.legacy.import": [
    "import_batch"
  ],
  "construct.originators": [
    "agent"
  ],
  "construct.origin_source": [
    "source"
  ],
  "construct.origin_passage": [
    "passage"
  ],
  "construct.chapters": [
    "chapter"
  ],
  "construct.relations.target": [
    "construct"
  ],
  "construct.origins.import": [
    "import_batch"
  ],
  "construct.review.decided.import": [
    "import_batch"
  ],
  "method.created.import": [
    "import_batch"
  ],
  "method.changed.import": [
    "import_batch"
  ],
  "method.retired.stamp.import": [
    "import_batch"
  ],
  "method.legacy.import": [
    "import_batch"
  ],
  "method.draws_on": [
    "source"
  ],
  "method.origins.import": [
    "import_batch"
  ],
  "method.review.decided.import": [
    "import_batch"
  ],
  "chapter.created.import": [
    "import_batch"
  ],
  "chapter.changed.import": [
    "import_batch"
  ],
  "chapter.retired.stamp.import": [
    "import_batch"
  ],
  "chapter.legacy.import": [
    "import_batch"
  ],
  "citation.created.import": [
    "import_batch"
  ],
  "citation.changed.import": [
    "import_batch"
  ],
  "citation.retired.stamp.import": [
    "import_batch"
  ],
  "citation.legacy.import": [
    "import_batch"
  ],
  "citation.chapter": [
    "chapter"
  ],
  "citation.source": [
    "source"
  ],
  "citation.claims": [
    "claim"
  ],
  "place.created.import": [
    "import_batch"
  ],
  "place.changed.import": [
    "import_batch"
  ],
  "place.retired.stamp.import": [
    "import_batch"
  ],
  "place.legacy.import": [
    "import_batch"
  ],
  "place.review.decided.import": [
    "import_batch"
  ],
  "place_name.created.import": [
    "import_batch"
  ],
  "place_name.changed.import": [
    "import_batch"
  ],
  "place_name.retired.stamp.import": [
    "import_batch"
  ],
  "place_name.legacy.import": [
    "import_batch"
  ],
  "place_name.place": [
    "place"
  ],
  "place_name.evidence": [
    "passage",
    "source"
  ],
  "place_name.review.decided.import": [
    "import_batch"
  ],
  "place_location.created.import": [
    "import_batch"
  ],
  "place_location.changed.import": [
    "import_batch"
  ],
  "place_location.retired.stamp.import": [
    "import_batch"
  ],
  "place_location.legacy.import": [
    "import_batch"
  ],
  "place_location.place": [
    "place"
  ],
  "place_location.sensitivity.decided.import": [
    "import_batch"
  ],
  "place_location.evidence": [
    "passage",
    "source"
  ],
  "place_location.review.decided.import": [
    "import_batch"
  ],
  "place_assertion.created.import": [
    "import_batch"
  ],
  "place_assertion.changed.import": [
    "import_batch"
  ],
  "place_assertion.retired.stamp.import": [
    "import_batch"
  ],
  "place_assertion.legacy.import": [
    "import_batch"
  ],
  "place_assertion.subject": [
    "place",
    "passage",
    "claim"
  ],
  "place_assertion.place": [
    "place"
  ],
  "place_assertion.evidence": [
    "passage",
    "source"
  ],
  "place_assertion.review.decided.import": [
    "import_batch"
  ],
  "search.created.import": [
    "import_batch"
  ],
  "search.changed.import": [
    "import_batch"
  ],
  "search.retired.stamp.import": [
    "import_batch"
  ],
  "search.legacy.import": [
    "import_batch"
  ],
  "search.performed.import": [
    "import_batch"
  ],
  "search.candidates": [
    "source"
  ],
  "decision.created.import": [
    "import_batch"
  ],
  "decision.changed.import": [
    "import_batch"
  ],
  "decision.retired.stamp.import": [
    "import_batch"
  ],
  "decision.legacy.import": [
    "import_batch"
  ],
  "decision.source": [
    "source"
  ],
  "decision.search": [
    "search"
  ],
  "decision.decided.import": [
    "import_batch"
  ],
  "support_record.created.import": [
    "import_batch"
  ],
  "support_record.changed.import": [
    "import_batch"
  ],
  "support_record.retired.stamp.import": [
    "import_batch"
  ],
  "support_record.legacy.import": [
    "import_batch"
  ],
  "support_record.claim": [
    "claim"
  ],
  "support_record.passage": [
    "passage"
  ],
  "support_record.checked.import": [
    "import_batch"
  ],
  "annotation.created.import": [
    "import_batch"
  ],
  "annotation.changed.import": [
    "import_batch"
  ],
  "annotation.retired.stamp.import": [
    "import_batch"
  ],
  "annotation.legacy.import": [
    "import_batch"
  ],
  "annotation.source.source": [
    "source"
  ],
  "annotation.item.record": [
    "source",
    "citation",
    "claim",
    "construct",
    "note",
    "agent",
    "capture",
    "extraction",
    "passage",
    "attestation",
    "inference",
    "method",
    "chapter",
    "place",
    "place_name",
    "place_location",
    "place_assertion",
    "search",
    "decision",
    "support_record",
    "annotation",
    "intake_item",
    "round_choice",
    "review_comment",
    "resolution",
    "import_batch",
    "confirmation",
    "plan",
    "checkpoint_input",
    "authorship_mark",
    "ai_activity",
    "voice_profile",
    "voice_example",
    "governing_record",
    "governing_entry",
    "ai_role",
    "audit_finding",
    "review_baseline",
    "image",
    "conversion"
  ],
  "annotation.compared.extraction": [
    "extraction"
  ],
  "annotation.written.import": [
    "import_batch"
  ],
  "intake_item.created.import": [
    "import_batch"
  ],
  "intake_item.changed.import": [
    "import_batch"
  ],
  "intake_item.retired.stamp.import": [
    "import_batch"
  ],
  "intake_item.legacy.import": [
    "import_batch"
  ],
  "intake_item.import": [
    "import_batch"
  ],
  "intake_item.candidates": [
    "source"
  ],
  "intake_item.citation": [
    "citation"
  ],
  "round_choice.created.import": [
    "import_batch"
  ],
  "round_choice.changed.import": [
    "import_batch"
  ],
  "round_choice.retired.stamp.import": [
    "import_batch"
  ],
  "round_choice.legacy.import": [
    "import_batch"
  ],
  "round_choice.citation": [
    "citation"
  ],
  "round_choice.item": [
    "intake_item"
  ],
  "round_choice.previous_source": [
    "source"
  ],
  "round_choice.new_source": [
    "source"
  ],
  "round_choice.claims": [
    "claim"
  ],
  "round_choice.chosen.import": [
    "import_batch"
  ],
  "review_comment.created.import": [
    "import_batch"
  ],
  "review_comment.changed.import": [
    "import_batch"
  ],
  "review_comment.retired.stamp.import": [
    "import_batch"
  ],
  "review_comment.legacy.import": [
    "import_batch"
  ],
  "review_comment.claim": [
    "claim"
  ],
  "resolution.created.import": [
    "import_batch"
  ],
  "resolution.changed.import": [
    "import_batch"
  ],
  "resolution.retired.stamp.import": [
    "import_batch"
  ],
  "resolution.legacy.import": [
    "import_batch"
  ],
  "resolution.source": [
    "source"
  ],
  "import_batch.created.import": [
    "import_batch"
  ],
  "import_batch.changed.import": [
    "import_batch"
  ],
  "import_batch.retired.stamp.import": [
    "import_batch"
  ],
  "import_batch.legacy.import": [
    "import_batch"
  ],
  "search.candidate_origins.source": [
    "source"
  ],
  "confirmation.source": [
    "source"
  ],
  "confirmation.capture": [
    "capture"
  ],
  "plan.chapter": [
    "chapter"
  ],
  "plan.claims": [
    "claim"
  ],
  "plan.constructs": [
    "construct"
  ],
  "plan.methods": [
    "method"
  ],
  "checkpoint_input.chapter": [
    "chapter"
  ],
  "authorship_mark.chapter": [
    "chapter"
  ],
  "ai_activity.chapter": [
    "chapter"
  ],
  "ai_activity.voice_profile": [
    "voice_profile"
  ],
  "project.voice_profile": [
    "voice_profile"
  ],
  "voice_example.profile": [
    "voice_profile"
  ],
  "governing_record.depends_on": [
    "governing_entry"
  ],
  "governing_entry.record": [
    "governing_record"
  ],
  "governing_entry.chapter": [
    "chapter"
  ],
  "audit_finding.chapter": [
    "chapter"
  ],
  "audit_finding.claim": [
    "claim"
  ],
  "audit_finding.unexamined_sources": [
    "source"
  ],
  "image.source": [
    "source"
  ],
  "ai_activity.records": [
    "source",
    "agent",
    "capture",
    "extraction",
    "passage",
    "note",
    "claim",
    "attestation",
    "inference",
    "construct",
    "method",
    "chapter",
    "citation",
    "place",
    "place_name",
    "place_location",
    "place_assertion",
    "search",
    "decision",
    "support_record",
    "annotation",
    "intake_item",
    "round_choice",
    "review_comment",
    "resolution",
    "import_batch",
    "confirmation",
    "plan",
    "checkpoint_input",
    "authorship_mark",
    "ai_activity",
    "voice_profile",
    "voice_example",
    "governing_record",
    "governing_entry",
    "ai_role",
    "audit_finding",
    "review_baseline",
    "image",
    "conversion"
  ],
  "source.retired.replaced_by": [
    "source"
  ],
  "agent.retired.replaced_by": [
    "agent"
  ],
  "capture.retired.replaced_by": [
    "capture"
  ],
  "extraction.retired.replaced_by": [
    "extraction"
  ],
  "passage.retired.replaced_by": [
    "passage"
  ],
  "note.retired.replaced_by": [
    "note"
  ],
  "claim.retired.replaced_by": [
    "claim"
  ],
  "attestation.retired.replaced_by": [
    "attestation"
  ],
  "inference.retired.replaced_by": [
    "inference"
  ],
  "construct.retired.replaced_by": [
    "construct"
  ],
  "method.retired.replaced_by": [
    "method"
  ],
  "chapter.retired.replaced_by": [
    "chapter"
  ],
  "citation.retired.replaced_by": [
    "citation"
  ],
  "place.retired.replaced_by": [
    "place"
  ],
  "place_name.retired.replaced_by": [
    "place_name"
  ],
  "place_location.retired.replaced_by": [
    "place_location"
  ],
  "place_assertion.retired.replaced_by": [
    "place_assertion"
  ],
  "search.retired.replaced_by": [
    "search"
  ],
  "decision.retired.replaced_by": [
    "decision"
  ],
  "support_record.retired.replaced_by": [
    "support_record"
  ],
  "annotation.retired.replaced_by": [
    "annotation"
  ],
  "intake_item.retired.replaced_by": [
    "intake_item"
  ],
  "round_choice.retired.replaced_by": [
    "round_choice"
  ],
  "review_comment.retired.replaced_by": [
    "review_comment"
  ],
  "resolution.retired.replaced_by": [
    "resolution"
  ],
  "import_batch.retired.replaced_by": [
    "import_batch"
  ],
  "confirmation.created.import": [
    "import_batch"
  ],
  "confirmation.changed.import": [
    "import_batch"
  ],
  "confirmation.retired.stamp.import": [
    "import_batch"
  ],
  "confirmation.retired.replaced_by": [
    "confirmation"
  ],
  "confirmation.legacy.import": [
    "import_batch"
  ],
  "confirmation.confirmed.import": [
    "import_batch"
  ],
  "plan.created.import": [
    "import_batch"
  ],
  "plan.changed.import": [
    "import_batch"
  ],
  "plan.retired.stamp.import": [
    "import_batch"
  ],
  "plan.retired.replaced_by": [
    "plan"
  ],
  "plan.legacy.import": [
    "import_batch"
  ],
  "plan.review.decided.import": [
    "import_batch"
  ],
  "checkpoint_input.created.import": [
    "import_batch"
  ],
  "checkpoint_input.changed.import": [
    "import_batch"
  ],
  "checkpoint_input.retired.stamp.import": [
    "import_batch"
  ],
  "checkpoint_input.retired.replaced_by": [
    "checkpoint_input"
  ],
  "checkpoint_input.legacy.import": [
    "import_batch"
  ],
  "checkpoint_input.given.import": [
    "import_batch"
  ],
  "authorship_mark.created.import": [
    "import_batch"
  ],
  "authorship_mark.changed.import": [
    "import_batch"
  ],
  "authorship_mark.retired.stamp.import": [
    "import_batch"
  ],
  "authorship_mark.retired.replaced_by": [
    "authorship_mark"
  ],
  "authorship_mark.legacy.import": [
    "import_batch"
  ],
  "authorship_mark.marked.import": [
    "import_batch"
  ],
  "ai_activity.created.import": [
    "import_batch"
  ],
  "ai_activity.changed.import": [
    "import_batch"
  ],
  "ai_activity.retired.stamp.import": [
    "import_batch"
  ],
  "ai_activity.retired.replaced_by": [
    "ai_activity"
  ],
  "ai_activity.legacy.import": [
    "import_batch"
  ],
  "ai_activity.performed.import": [
    "import_batch"
  ],
  "voice_profile.created.import": [
    "import_batch"
  ],
  "voice_profile.changed.import": [
    "import_batch"
  ],
  "voice_profile.retired.stamp.import": [
    "import_batch"
  ],
  "voice_profile.retired.replaced_by": [
    "voice_profile"
  ],
  "voice_profile.legacy.import": [
    "import_batch"
  ],
  "voice_profile.review.decided.import": [
    "import_batch"
  ],
  "voice_example.created.import": [
    "import_batch"
  ],
  "voice_example.changed.import": [
    "import_batch"
  ],
  "voice_example.retired.stamp.import": [
    "import_batch"
  ],
  "voice_example.retired.replaced_by": [
    "voice_example"
  ],
  "voice_example.legacy.import": [
    "import_batch"
  ],
  "voice_example.provided.import": [
    "import_batch"
  ],
  "governing_record.created.import": [
    "import_batch"
  ],
  "governing_record.changed.import": [
    "import_batch"
  ],
  "governing_record.retired.stamp.import": [
    "import_batch"
  ],
  "governing_record.retired.replaced_by": [
    "governing_record"
  ],
  "governing_record.legacy.import": [
    "import_batch"
  ],
  "governing_entry.created.import": [
    "import_batch"
  ],
  "governing_entry.changed.import": [
    "import_batch"
  ],
  "governing_entry.retired.stamp.import": [
    "import_batch"
  ],
  "governing_entry.retired.replaced_by": [
    "governing_entry"
  ],
  "governing_entry.legacy.import": [
    "import_batch"
  ],
  "ai_role.created.import": [
    "import_batch"
  ],
  "ai_role.changed.import": [
    "import_batch"
  ],
  "ai_role.retired.stamp.import": [
    "import_batch"
  ],
  "ai_role.retired.replaced_by": [
    "ai_role"
  ],
  "ai_role.legacy.import": [
    "import_batch"
  ],
  "audit_finding.created.import": [
    "import_batch"
  ],
  "audit_finding.changed.import": [
    "import_batch"
  ],
  "audit_finding.retired.stamp.import": [
    "import_batch"
  ],
  "audit_finding.retired.replaced_by": [
    "audit_finding"
  ],
  "audit_finding.legacy.import": [
    "import_batch"
  ],
  "audit_finding.found.import": [
    "import_batch"
  ],
  "review_baseline.created.import": [
    "import_batch"
  ],
  "review_baseline.changed.import": [
    "import_batch"
  ],
  "review_baseline.retired.stamp.import": [
    "import_batch"
  ],
  "review_baseline.retired.replaced_by": [
    "review_baseline"
  ],
  "review_baseline.legacy.import": [
    "import_batch"
  ],
  "review_baseline.taken.import": [
    "import_batch"
  ],
  "image.created.import": [
    "import_batch"
  ],
  "image.changed.import": [
    "import_batch"
  ],
  "image.retired.stamp.import": [
    "import_batch"
  ],
  "image.retired.replaced_by": [
    "image"
  ],
  "image.legacy.import": [
    "import_batch"
  ],
  "conversion.created.import": [
    "import_batch"
  ],
  "conversion.changed.import": [
    "import_batch"
  ],
  "conversion.retired.stamp.import": [
    "import_batch"
  ],
  "conversion.retired.replaced_by": [
    "conversion"
  ],
  "conversion.legacy.import": [
    "import_batch"
  ],
  "conversion.performed.import": [
    "import_batch"
  ],
  "project.bibliography_include": [
    "source"
  ]
};

// packages/records/src/validate.ts
var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var invalid = (code, field) => ({ reason: "record_invalid", code, field });
var TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
function checkScalar(value, spec, name, field, problems) {
  const type = spec.type;
  const ok = type === "boolean" ? typeof value === "boolean" : type === "integer" ? Number.isSafeInteger(value) : typeof value === "string";
  if (!ok)
    problems.push(invalid("wrong_type", field));
  else if (type === "date-time" && !TIME.test(value))
    problems.push(invalid("bad_time", field));
  else if (spec.values && !spec.values.includes(value))
    problems.push(invalid("value_not_allowed", field));
  else if (/sha256$/.test(name) && !/^[0-9a-f]{64}$/.test(value))
    problems.push(invalid("bad_digest", field));
}
function checkShape(typeName, value, field, refPath, problems, references) {
  if (!isObject(value)) {
    problems.push(invalid("not_an_object", field));
    return;
  }
  const fields = TYPES[typeName];
  for (const [name, spec] of Object.entries(fields)) {
    if (spec.required && !Object.hasOwn(value, name))
      problems.push(invalid("missing_field", `${field}/${name}`));
  }
  for (const [name, item] of Object.entries(value)) {
    const at = `${field}/${name}`;
    const spec = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (!spec) {
      if (name !== "x")
        problems.push({ reason: "unknown_field", code: "unknown_field", field: at });
      continue;
    }
    if (item === null)
      continue;
    if (spec.many && !Array.isArray(item)) {
      problems.push(invalid("not_a_list", at));
      continue;
    }
    const path = `${refPath}.${name}`;
    const items = spec.many ? item.map((v, i) => [v, `${at}/${i}`]) : [[item, at]];
    for (const [one, where] of items) {
      if (typeof spec.type === "object") {
        checkShape(spec.type.value, one, where, path, problems, references);
        continue;
      }
      checkScalar(one, spec, name, where, problems);
      const allowed = Object.hasOwn(REFERENCES, path) ? REFERENCES[path] : undefined;
      if (allowed && typeof one === "string")
        references.push({ field: where, id: one, allowed });
    }
  }
}
var CITATION_KEY = /^[A-Za-z0-9_]([A-Za-z0-9_:.-]{0,126}[A-Za-z0-9_])?$/;
function duplicates(list, property, field, problems) {
  if (!Array.isArray(list))
    return;
  const seen = new Set;
  list.forEach((item, i) => {
    const name = isObject(item) ? item[property] : undefined;
    if (typeof name !== "string")
      return;
    if (seen.has(name))
      problems.push(invalid("duplicate_name", `${field}/${i}/${property}`));
    seen.add(name);
  });
}
function checkRules(record, problems) {
  if (record.kind === "source") {
    if (typeof record.citation_key === "string" && !CITATION_KEY.test(record.citation_key)) {
      problems.push(invalid("bad_citation_key", "/citation_key"));
    }
    if (Array.isArray(record.key_aliases)) {
      record.key_aliases.forEach((key, i) => {
        if (typeof key === "string" && !CITATION_KEY.test(key))
          problems.push(invalid("bad_citation_key", `/key_aliases/${i}`));
      });
    }
    duplicates(record.bib, "name", "/bib", problems);
    duplicates(record.dates, "variable", "/dates", problems);
    for (const list of ["contributions", "relations"]) {
      const entries = record[list];
      duplicates(entries, "lid", `/${list}`, problems);
      if (!Array.isArray(entries))
        continue;
      entries.forEach((entry, i) => {
        if (isObject(entry) && typeof entry.lid === "string" && !/^[0-9a-z]{1,32}$/.test(entry.lid)) {
          problems.push(invalid("bad_link_id", `/${list}/${i}/lid`));
        }
      });
    }
  }
  if (record.kind === "capture" || record.kind === "extraction") {
    const field = record.kind === "capture" ? "size" : "text_size";
    if (typeof record[field] === "number" && record[field] < 0)
      problems.push(invalid("bad_size", `/${field}`));
  }
  if (record.kind === "extraction") {
    for (const { code, index } of checkPageSegments(record.pages ?? []))
      problems.push(invalid(code, `/pages/${index}`));
    for (const index of checkPageSpans(record.page_spans ?? []))
      problems.push(invalid("bad_page_spans", `/page_spans/${index}`));
  }
  if (record.kind === "citation" && isObject(record.sentence)) {
    const { text, sha256: stated } = record.sentence;
    if (typeof text !== "string")
      return;
    if (normalizeSentence(text) !== text)
      problems.push(invalid("sentence_not_normalized", "/sentence/text"));
    else if (typeof stated === "string" && stated !== sha256(text)) {
      problems.push(invalid("sentence_digest_mismatch", "/sentence/sha256"));
    }
  }
}
function validateRecord(record, path) {
  const problems = [];
  const references = [];
  if (!isObject(record))
    return { problems: [invalid("not_an_object", "")], references };
  const kind = typeof record.kind === "string" ? record.kind : "";
  if (!Object.hasOwn(KINDS, kind))
    return { problems: [invalid("unknown_kind", "/kind")], references };
  checkShape(KIND_TYPES[kind], record, "", kind, problems, references);
  if (typeof record.id === "string") {
    if (!isRecordId(kind, record.id))
      problems.push(invalid("bad_id", "/id"));
    const expected = `records/${KINDS[kind].directory}/${record.id}.json`;
    if (path !== expected) {
      const problem = { reason: "record_misplaced", code: "wrong_location", field: "/id" };
      if (isRecordId(kind, record.id))
        problem.target = expected;
      problems.push(problem);
    }
  }
  checkRules(record, problems);
  return { problems, references };
}
function validateProject(settings) {
  const problems = [];
  const references = [];
  checkShape("Project", settings, "", "project", problems, references);
  return { problems, references };
}
function checkRuleHeadings(text) {
  const problems = [];
  const seen = new Set;
  let fence = false;
  text.split(/\r?\n/).forEach((content, i) => {
    if (/^(```|~~~)/.test(content))
      fence = !fence;
    if (fence || !/^## /.test(content))
      return;
    const rule = /^## (RULE-\d{3,}) \S/.exec(content)?.[1];
    if (!rule)
      problems.push({ code: "rule_heading_invalid", line: i + 1 });
    else if (seen.has(rule))
      problems.push({ code: "rule_id_duplicate", line: i + 1, rule });
    else
      seen.add(rule);
  });
  return problems;
}

// packages/records/src/corpus.ts
function newerVersion(schema, prefix) {
  if (typeof schema !== "string" || !schema.startsWith(`${prefix}/`))
    return false;
  return Number(schema.slice(prefix.length + 1)) > PROJECT_FORMAT;
}
function loadFile(file, type) {
  const base = { path: file.path, state: "unreadable", formattable: false, problems: [], references: [] };
  if (file.bytes)
    base.bytes = file.bytes;
  if (type === "record" && !/^records\/.*\.json$/.test(file.path)) {
    return { ...base, state: "stray", problems: [{ reason: "record_misplaced", code: "stray_file", field: "" }] };
  }
  if (!file.bytes)
    return { ...base, unreadable: "cannot_open" };
  let text;
  let value;
  let forbidden;
  try {
    text = decodeUtf8(file.bytes);
    ({ value, forbidden } = parseJson(text));
  } catch (error) {
    if (error instanceof JsonUnreadable)
      return { ...base, unreadable: error.problem };
    throw error;
  }
  const prefix = (type === "record" ? RECORD_SCHEMA : PROJECT_SCHEMA).split("/")[0];
  if (isObject(value) && (newerVersion(value.schema, prefix) || type === "project" && Number(value.format) > PROJECT_FORMAT)) {
    return { ...base, state: "version_unsupported" };
  }
  const validation = type === "record" ? validateRecord(value, file.path) : validateProject(value);
  const loaded = {
    ...base,
    state: "ok",
    canonical: text.replace(/\r\n/g, `
`) === canonical(value),
    formattable: forbidden.length === 0,
    problems: [
      ...forbidden.map((f) => ({ reason: "record_invalid", code: f.problem, field: f.field })),
      ...validation.problems
    ],
    references: validation.references
  };
  if (isObject(value))
    loaded.data = value;
  return loaded;
}
var idOf = (file) => typeof file.data?.id === "string" ? file.data.id : undefined;
var isRetired = (data) => data.retired !== undefined;
function citationKeys(source) {
  const aliases = Array.isArray(source.key_aliases) ? source.key_aliases : [];
  return [source.citation_key, ...aliases].filter((k) => typeof k === "string");
}
function checkKeys(sources) {
  const holders = new Map;
  for (const file of sources) {
    const data = file.data;
    const fields = [[data.citation_key, "/citation_key"]];
    if (Array.isArray(data.key_aliases))
      data.key_aliases.forEach((k, i) => fields.push([k, `/key_aliases/${i}`]));
    for (const [key, field] of fields) {
      if (typeof key !== "string")
        continue;
      const folded = key.replace(/[A-Z]/g, (c) => c.toLowerCase());
      holders.set(folded, [...holders.get(folded) ?? [], { file, field }]);
    }
  }
  const handedOver = (old, other) => {
    const retired = old.data.retired;
    return isObject(retired) && retired.replaced_by === idOf(other.file) && other.field.startsWith("/key_aliases/");
  };
  for (const list of holders.values()) {
    for (const entry of list) {
      const clash = list.find((o) => o !== entry && !handedOver(entry.file, o) && !handedOver(o.file, entry));
      if (!clash)
        continue;
      entry.file.problems.push({ reason: "record_invalid", code: "duplicate_citation_key", field: entry.field, target: clash.file.path });
    }
  }
}
function checkReferences(file, byId, unreadableIds) {
  for (const reference of file.references) {
    const target = byId.get(reference.id);
    if (!target && unreadableIds.has(reference.id))
      continue;
    const code = !target ? "reference_missing" : !reference.allowed.includes(String(target.data.kind)) ? "reference_wrong_kind" : undefined;
    if (code)
      file.problems.push({ reason: "reference_dangling", code, field: reference.field, target: reference.id });
  }
}
function checkExtractions(records, byId) {
  for (const file of records) {
    if (file.state !== "ok" || file.data?.kind !== "extraction")
      continue;
    const capture = byId.get(String(file.data.capture));
    if (capture?.data?.kind !== "capture")
      continue;
    const add = (code, field) => file.problems.push({ reason: "record_invalid", code, field, target: capture.path });
    if (file.data.capture_sha256 !== capture.data.sha256)
      add("capture_digest_mismatch", "/capture_sha256");
    const spans = file.data.page_spans;
    if (capture.data.media_type === "application/pdf" && !(Array.isArray(spans) && spans.length > 0)) {
      add("missing_page_spans", "/page_spans");
    }
  }
}
function loadCorpus(content) {
  const settings = loadFile(content.settings, "project");
  const records = [...content.records].sort((a, b) => compareCodePoints(a.path, b.path)).map((file) => loadFile(file, "record"));
  const byId = new Map;
  const unreadableIds = new Set;
  for (const file of records) {
    if (file.state !== "ok") {
      unreadableIds.add(file.path.replace(/^.*\//, "").replace(/\.json$/, ""));
      continue;
    }
    const id = idOf(file);
    if (id === undefined)
      continue;
    const first = byId.get(id);
    if (first)
      file.problems.push({ reason: "record_invalid", code: "duplicate_id", field: "/id", target: first.path });
    else
      byId.set(id, file);
  }
  checkKeys(records.filter((f) => f.state === "ok" && f.data?.kind === "source"));
  for (const file of [settings, ...records])
    checkReferences(file, byId, unreadableIds);
  checkExtractions(records, byId);
  const corpus = { settings, records, byId, manuscript: content.manuscript };
  if (content.rules)
    corpus.rules = content.rules;
  return corpus;
}
function corpusDigest(corpus) {
  const lines = [corpus.settings, ...corpus.records].map((file) => [
    file.path,
    file.data ? digest(file.data) : file.bytes ? sha256(file.bytes) : "unreadable"
  ]);
  if (corpus.rules) {
    const text = corpus.rules.bytes ? new TextDecoder().decode(corpus.rules.bytes).replace(/\r\n?/g, `
`) : "unreadable";
    lines.push([corpus.rules.path, sha256(text)]);
  }
  return sha256(lines.sort((a, b) => compareCodePoints(a[0], b[0])).map(([p, d]) => `${p}	${d}
`).join(""));
}
// packages/core/src/findings.ts
var RECORD_WHY = "Every other check reads these files. A broken record can hide a citation problem or create a false one.";
var HELD_WHY = "Without a stored copy and its text, nobody can compare this citation with the source, so it is unchecked.";
var INTEGRITY_WHY = "The records describe one exact file. A missing or changed file cannot stand for it, so nothing that depends on it can be checked.";
var KEY_WHY = "A reader or a build cannot tell which source this citation means, so it cannot be checked or put in the bibliography.";
var COORDINATE_WHY = "This output can disclose a restricted site's position. The scan cannot tell whether a site is restricted, so it warns about every coordinate it recognizes.";
var explain = (message, why, suggestions, fixes = []) => ({ message, why, suggestions, fixes });
var TEMPLATES = {
  "record.valid:record_unreadable": explain("A file cannot be read as a record, so nothing in it was checked.", RECORD_WHY, ["Open the named file and repair it (look for merge-conflict markers, a repeated key or a missing bracket), or restore it from git. Stemma does not guess its content."]),
  "record.valid:version_unsupported": explain("A file was written in a newer record format than this version reads, so it was not checked.", RECORD_WHY, ["Update Stemma before changing this file. This version will not rewrite it."]),
  "record.valid:record_noncanonical": explain("A file is not written in the canonical form (key order, indentation or line endings differ).", "Digests, review marks and diffs depend on one exact form. No value is wrong because of this alone.", ["Run `fmt` on the file. It rewrites the layout and changes no value."], ["format"]),
  "record.valid:record_invalid": explain("A record breaks a rule of the record format.", RECORD_WHY, ["Correct the field named in the evidence, then run `check` again."]),
  "record.valid:record_misplaced": explain("A file under records/ is not where its record belongs (file name or directory does not match).", "References and tools find records by ID, directory and file name.", ["Rename or move the file as the evidence shows, or move a file that is not a record out of records/."]),
  "record.valid:reference_dangling": explain("A record points at a record that is missing or is of the wrong kind.", "The link between your evidence and its source is broken, so anything relying on it cannot be traced.", ["Point the reference at the right record, or remove it."], ["repoint"]),
  "record.valid:unknown_field": explain("A record has a field the record format does not define. The field is kept as it is.", "A misspelled field name means the value you meant to record is not read.", ["Check the spelling. Put a field of your own under `x` with a namespaced name such as `myname.note`."]),
  "record.valid:rule_heading_invalid": explain("A heading in rules.md is not a rule heading.", "Reports and records cite standing rules by ID, so a rule without one cannot be cited.", ["Write each rule heading as `## RULE-001 Title`."]),
  "record.valid:rule_id_duplicate": explain("A rule ID in rules.md is used twice.", "A report or record citing this ID could mean either rule.", ["Give the later rule a number that has never been used."]),
  "record.valid:check_error": explain("The check itself failed while running, so this was not checked.", "This is a defect in Stemma, not a pass.", ["Report the defect together with the Stemma version."]),
  "cite.key:key_unknown": explain("A citation uses a key that no source record holds.", KEY_WHY, ["Correct the key in the citation, or add a source record with that key (or add it to the right source's key_aliases)."], ["repoint", "add_source", "remove_citation"]),
  "cite.key:key_ambiguous": explain("A citation uses a key that more than one source record holds.", KEY_WHY, ["Give each source its own key."], ["rename_key"]),
  "cite.key:key_missing": explain("A citation record names no citation key and no source.", KEY_WHY, ["Add the key of the source being cited, or remove the citation."], ["repoint", "remove_citation"]),
  "cite.key:source_unreadable": explain("A citation's key could not be looked up because at least one source record cannot be read.", "The unreadable file may or may not be the source this citation means.", ["Repair the unreadable source record first (see the record.valid finding), then run `check` again."]),
  "cite.key:check_error": explain("The check itself failed while running, so this was not checked.", "This is a defect in Stemma, not a pass.", ["Report the defect together with the Stemma version."]),
  "bib.uncited:not_cited": explain("A source is listed for the built bibliography but cited nowhere.", "The bibliography would list a work the book never cites, or a citation you meant to make is missing.", ["Cite it, remove it from bibliography_include in stemma.json, or keep it on purpose and record why."], ["add_citation", "remove_from_bibliography"]),
  "bib.uncited:no_manuscript": explain("Whether a listed source is cited could not be checked: there is no manuscript and there are no citation records.", "An unused bibliography entry would go unnoticed.", ["Add citation records for the citations in your manuscript, or run this again once the manuscript is in the project."]),
  "bib.uncited:manuscript_not_read": explain("Whether a listed source is cited could not be checked: this version does not read the files in manuscript/.", "The manuscript, not the citation records, says what is cited now, so a guess could be wrong either way.", ["Nothing to fix in your files. Check this entry by hand."]),
  "bib.uncited:citation_unreadable": explain("Whether a listed source is cited could not be checked: at least one citation record cannot be read.", "The unreadable file may be the citation of this source.", ["Repair the unreadable citation record first (see the record.valid finding), then run `check` again."]),
  "bib.uncited:check_error": explain("The check itself failed while running, so this was not checked.", "This is a defect in Stemma, not a pass.", ["Report the defect together with the Stemma version."]),
  "source.held:no_copy": explain("A cited source has no stored copy, so this citation is unchecked.", HELD_WHY, ["Add your copy (`source add <file> --source <id>`). For a book you hold only on paper, add a scan and attach its text. Writing can carry on meanwhile."], ["add_copy", "remove_citation"]),
  "source.held:no_text": explain("A cited source has a stored copy but no extracted text, so this citation is unchecked.", HELD_WHY, ["Attach the text (`source text <capture id>`). A plain UTF-8 text copy is read as it is. For a PDF or scan, supply its text layer with page breaks (`--text-layer <file>`); this version cannot read a PDF itself. A scan with no machine-readable text stays unchecked."], ["add_text"]),
  "source.held:record_unreadable": explain("Whether you hold this cited source could not be checked: at least one capture or extraction record cannot be read.", "The unreadable file may be the record of the stored copy or of its text.", ["Repair the unreadable record first (see the record.valid finding), then run `check` again."]),
  "source.held:copy_missing": explain("A stored copy could not be checked: its file is not in the content store used here.", INTEGRITY_WHY, ["The content store is private and is not part of the repository. Point `--store-dir` at it, restore the file from your backup, or add the same file again. `store verify` lists every missing digest."], ["restore_copy"]),
  "source.held:copy_altered": explain("A stored copy no longer matches its recorded digest, so it is not treated as the copy that was added.", INTEGRITY_WHY, ["Restore the file from your backup, or add the original file again. If the source itself changed, add it as a new copy."], ["restore_copy"]),
  "source.held:text_missing": explain("The extracted text of a stored copy could not be checked: it is not in the content store used here.", INTEGRITY_WHY, ["Point `--store-dir` at the store that holds it, or restore it from your backup. `store verify` lists every missing digest."], ["restore_text"]),
  "source.held:text_altered": explain("The stored text of a copy no longer matches its recorded digest, so it is not used.", INTEGRITY_WHY, ["Restore the text from your backup, or attach the text again as a new extraction."], ["restore_text"]),
  "source.held:text_inconsistent": explain("An extraction record does not fit its stored text (its size or page spans disagree with it), so it is not used.", INTEGRITY_WHY, ["Retire this extraction and attach the text again as a new one. An extraction is never edited."], ["add_text"]),
  "source.held:check_error": explain("The check itself failed while running, so this was not checked.", "This is a defect in Stemma, not a pass.", ["Report the defect together with the Stemma version."]),
  "coordinate.stray:coordinate_text": explain("Text in a project file looks like a map coordinate. The value is not repeated here.", COORDINATE_WHY, ["Look at the position in the evidence. If it is a sensitive site, remove the value from the file (git history may still hold it). If it is public or not a coordinate, you need do nothing."]),
  "coordinate.stray:file_unreadable": explain("A project file could not be read, so it was not scanned for coordinates.", COORDINATE_WHY, ["Make the file a readable UTF-8 file inside the project, then run `check` again."]),
  "coordinate.stray:check_error": explain("The check itself failed while running, so this was not checked.", "This is a defect in Stemma, not a pass.", ["Report the defect together with the Stemma version."])
};
var PROBLEMS = {
  not_an_object: "expected a JSON object",
  missing_field: "a required field is missing",
  wrong_type: "the value has the wrong type",
  not_a_list: "expected a list",
  value_not_allowed: "the value is not one of the allowed values",
  bad_time: "expected a time with an offset, such as 2026-01-05T09:58:00Z",
  bad_digest: "expected 64 lowercase hexadecimal characters",
  bad_id: "the ID does not have this kind's prefix followed by 8 to 40 lowercase letters or digits",
  unknown_kind: "the kind is missing or unknown",
  bad_citation_key: "the citation key uses characters or an ending that keys may not have",
  duplicate_citation_key: "another source holds the same citation key (keys differ by more than letter case)",
  duplicate_id: "another record has the same ID",
  bad_link_id: "expected 1 to 32 lowercase letters or digits",
  duplicate_name: "the same name appears twice in this list",
  sentence_digest_mismatch: "the sentence digest does not match the sentence text",
  sentence_not_normalized: "the sentence text has extra or unusual white space",
  unknown_field: "the field is not part of the record format",
  wrong_location: "the file name or directory does not match the record",
  stray_file: "the file is not a .json record",
  reference_missing: "no record has this ID",
  reference_wrong_kind: "the record with this ID is of a kind that is not allowed here",
  null_value: "null is not allowed; leave the field out",
  number_not_integer: "numbers must be whole and within the safe range; write others as strings",
  bad_size: "a size cannot be below zero",
  bad_page_range: "a page-map segment has an impossible or overlapping range of file pages",
  bad_page_labels: "a page-map segment's labels do not fit its numbering style or its number of pages",
  label_evidence_missing: "a page-map segment gives printed labels without saying what evidence they come from",
  bad_page_spans: "page spans must be in page order, must not overlap, and must not end before they start",
  missing_page_spans: "an extraction of a PDF must say where each page's text starts and ends",
  capture_digest_mismatch: "the extraction names other bytes than the copy its capture holds"
};
var problemTemplate = (problem) => `record.valid:${problem.reason}`;
function result(parts) {
  const { check, outcome, reason, subject, locus, source, sentence, item } = parts;
  const explanation = outcome === "pass" ? undefined : TEMPLATES[`${check}:${reason}`];
  if (outcome !== "pass" && !explanation)
    throw new Error(`no explanation for ${check}:${reason}`);
  return {
    finding_key: digest({ check, subject, source, locus }),
    check,
    outcome,
    ...reason ? { reason_code: reason } : {},
    subject,
    ...sentence ? { sentence } : {},
    ...source ? { source } : {},
    ...item ? { item } : {},
    evidence: parts.evidence ?? [],
    fixes: [...explanation?.fixes ?? []],
    rules: [],
    message: explanation?.message ?? "Nothing was found by this check here.",
    why: explanation?.why ?? "",
    suggestions: [...explanation?.suggestions ?? []],
    annotations: [],
    open: outcome !== "pass"
  };
}
function sortResults(results) {
  return results.sort((a, b) => compareCodePoints(a.check, b.check) || compareCodePoints(a.subject, b.subject) || compareCodePoints(a.finding_key, b.finding_key));
}

// packages/core/src/checks/records.ts
function subjectOf(file) {
  const id = idOf(file);
  const owns = id !== undefined && isRecordId(String(file.data.kind), id) && file.path.endsWith(`/${id}.json`);
  return owns ? id : file.path;
}
function itemOf(file) {
  const { review: _r, created: _c, changed: _m, legacy: _l, x: _x, ...content } = file.data;
  return { record: idOf(file), content_sha256: digest(content) };
}
var location = (name, value) => ({ name, class: "location", value });
function fileResults(file) {
  const check = "record.valid";
  const subject = subjectOf(file);
  const evidence = [location("file", file.path)];
  const finding = (outcome, reason, locus, extra = []) => result({ check, outcome, reason, subject, locus: `${file.path}#${locus}`, evidence: [...evidence, ...extra] });
  if (file.state === "unreadable") {
    return [finding("unverifiable", "record_unreadable", "file", [{ name: "problem", class: "metadata", value: file.unreadable }])];
  }
  if (file.state === "version_unsupported")
    return [finding("unverifiable", "version_unsupported", "file")];
  const results = file.problems.map((problem) => {
    const extra = [
      ...problem.field ? [location("field", problem.field)] : [],
      { name: "problem", class: "metadata", value: PROBLEMS[problem.code] },
      ...problem.target ? [location(problem.code === "wrong_location" ? "expected_path" : "points_at", problem.target)] : []
    ];
    return finding("fail", problemTemplate(problem).split(":")[1], `${problem.code}${problem.field}`, extra);
  });
  if (file.state === "ok" && !file.canonical && file.formattable)
    results.push(finding("fail", "record_noncanonical", "form"));
  return results.length > 0 ? results : [result({ check, outcome: "pass", subject, locus: file.path, evidence })];
}
function rulesResults(corpus) {
  const file = corpus.rules;
  if (!file)
    return [];
  const check = "record.valid";
  const path = file.path;
  if (!file.bytes) {
    return [result({ check, outcome: "unverifiable", reason: "record_unreadable", subject: path, locus: path, evidence: [location("file", path)] })];
  }
  const problems = checkRuleHeadings(new TextDecoder().decode(file.bytes));
  if (problems.length === 0)
    return [result({ check, outcome: "pass", subject: path, locus: path, evidence: [location("file", path)] })];
  return problems.map((p, i) => result({
    check,
    outcome: "fail",
    reason: p.code,
    subject: path,
    locus: `${path}#${p.code}#${p.rule ?? i}`,
    evidence: [location("file", path), location("line", String(p.line))]
  }));
}

// packages/core/src/checks/bibliography.ts
var hasManuscript = (corpus) => corpus.manuscript.some((f) => f.path.endsWith(".md"));
function active(corpus, kind) {
  return corpus.records.filter((f) => f.state === "ok" && f.data?.kind === kind && !isRetired(f.data));
}
var unreadableIn = (corpus, directory) => corpus.records.some((f) => (f.state === "unreadable" || f.state === "version_unsupported") && f.path.startsWith(`records/${directory}/`));
function resolveCitations(corpus) {
  const sources = active(corpus, "source");
  return active(corpus, "citation").map((citation) => {
    const { key, source } = citation.data;
    if (typeof key === "string") {
      return { citation, key, matches: sources.filter((s) => citationKeys(s.data).includes(key)) };
    }
    return { citation, matches: sources.filter((s) => idOf(s) === source) };
  });
}
function listedSources(corpus) {
  const list = corpus.settings.data?.bibliography_include;
  if (!Array.isArray(list))
    return [];
  return [...new Set(list)].flatMap((id) => {
    const file = typeof id === "string" ? corpus.byId.get(id) : undefined;
    return file?.data?.kind === "source" ? [file] : [];
  });
}
function citeKeyResults(corpus) {
  if (hasManuscript(corpus))
    return [];
  const allSources = corpus.records.filter((f) => f.state === "ok" && f.data?.kind === "source");
  return resolveCitations(corpus).map(({ citation, key, matches }) => {
    const data = citation.data;
    const subject = subjectOf(citation);
    const evidence = [{ name: "citation_file", class: "location", value: citation.path }];
    if (key !== undefined)
      evidence.push({ name: "key", class: "manuscript", value: key });
    for (const [name, field] of [["chapter", "chapter"], ["document_position", "document_position"]]) {
      if (typeof data[field] === "string")
        evidence.push({ name, class: "location", value: data[field] });
    }
    if (isObject(data.locator)) {
      evidence.push({ name: "locator", class: "manuscript", value: `${String(data.locator.label)} ${String(data.locator.value)}` });
    }
    const only = matches.length === 1 ? idOf(matches[0]) : undefined;
    const sentence = isObject(data.sentence) && typeof data.sentence.text === "string" && typeof data.sentence.sha256 === "string" ? { text: data.sentence.text, sha256: data.sentence.sha256 } : undefined;
    if (sentence)
      evidence.push({ name: "sentence", class: "manuscript", value: sentence.text });
    const common = {
      check: "cite.key",
      subject,
      locus: idOf(citation) ?? citation.path,
      evidence,
      item: itemOf(citation),
      ...sentence ? { sentence } : {},
      ...only ? { source: only } : {}
    };
    if (only)
      return result({ ...common, outcome: "pass" });
    if (matches.length > 1) {
      for (const match of matches)
        evidence.push({ name: "held_by", class: "location", value: match.path });
      return result({ ...common, outcome: "fail", reason: "key_ambiguous" });
    }
    if (key === undefined && data.source === undefined)
      return result({ ...common, outcome: "fail", reason: "key_missing" });
    if (unreadableIn(corpus, "sources"))
      return result({ ...common, outcome: "unverifiable", reason: "source_unreadable" });
    if (key !== undefined) {
      for (const source of allSources) {
        for (const held of citationKeys(source.data)) {
          if (held === key)
            evidence.push({ name: "held_by_retired_source", class: "location", value: source.path });
          else if (held.toLowerCase() === key.toLowerCase()) {
            evidence.push({ name: "similar_key_differs_in_letter_case", class: "metadata", value: held });
          }
        }
      }
    }
    return result({ ...common, outcome: "fail", reason: "key_unknown" });
  });
}
function uncitedResults(corpus) {
  const cited = new Set(resolveCitations(corpus).flatMap((r) => r.matches.length === 1 ? [idOf(r.matches[0])] : []));
  return listedSources(corpus).map((source) => {
    const id = idOf(source);
    const key = source.data.citation_key;
    const evidence = [{ name: "source_file", class: "location", value: source.path }];
    if (typeof key === "string")
      evidence.push({ name: "key", class: "metadata", value: key });
    const { type, subtype, title, contributions, issued, dates, bib, identifiers, relations, extents, locator_label } = source.data;
    const binding = digest({ type, subtype, title, contributions, issued, dates, bib, identifiers, relations, extents, locator_label });
    const common = {
      check: "bib.uncited",
      subject: subjectOf(source),
      source: id,
      locus: "bibliography_include",
      evidence,
      item: { record: id, content_sha256: binding }
    };
    const cannot = hasManuscript(corpus) ? "manuscript_not_read" : cited.has(id) ? undefined : unreadableIn(corpus, "citations") ? "citation_unreadable" : active(corpus, "citation").length === 0 ? "no_manuscript" : undefined;
    if (cannot)
      return result({ ...common, outcome: "unverifiable", reason: cannot });
    return cited.has(id) ? result({ ...common, outcome: "pass" }) : result({ ...common, outcome: "fail", reason: "not_cited" });
  });
}

// packages/core/src/checks/not-run.ts
var CHECK_DESCRIPTIONS = {
  "record.valid": "the extra rules for some record kinds in this project",
  "cite.key": "citation keys in the manuscript files",
  "bib.uncited": "bibliography entries that are never cited",
  "source.held": "whether you hold a copy of each cited source, with its text extracted",
  "source.changed": "work that rests on a copy or source that has since changed",
  "quote.present": "whether quotations appear in the stored source text",
  "quote.self": "your own claims presented as quotations from a source",
  "locator.extent": "whether cited pages and other locators fall inside the source",
  "meta.source": "authors, titles and dates against your stored copies",
  "meta.resolver": "authors, titles and dates against saved catalogue lookups",
  "id.resolves": "whether DOIs and other identifiers name these works",
  "number.present": "whether cited figures appear in the stored source text",
  "construct.credit": "who each construct is credited to",
  "claim.complete": "whether each claim has evidence, confidence and a reason",
  "construct.complete": "whether each construct has a definition and ownership",
  "claim.inactive": "manuscript text linked to a retired claim",
  "cite.unlinked": "citations not linked to any claim",
  "takeover.removal": "claims left without support by removing a citation",
  "draft.marked": "passages marked as needing a source",
  "support.current": "whether each cited claim has a current claim-support record",
  "restricted.leak": "restricted site coordinates in project files",
  "coordinate.stray": "coordinates written in project files",
  "image.resolution": "image resolution",
  "image.alt": "image alternative text",
  "image.credit": "image credits",
  "image.permission": "image permissions",
  "image.vector": "vector images",
  "image.font": "image fonts",
  "image.placement": "image placement",
  "image.metadata": "location data inside images",
  "cite.format": "citation formatting (checked during a build)",
  "build.uncommitted": "uncommitted changes (checked during a build)",
  "changelog.missing": "the changelog entry (checked during a build)",
  "package.leak": "protected text in a reviewer package (checked during a build)"
};
function notRun(corpus) {
  const manuscript = hasManuscript(corpus);
  const citations = active(corpus, "citation");
  const has = (...kinds) => kinds.some((k) => active(corpus, k).length > 0);
  const used = [...new Set([...resolveCitations(corpus).flatMap((r) => r.matches), ...listedSources(corpus)])];
  const cited = citations.length > 0 || manuscript;
  const someCitation = (field) => citations.some((c) => c.data[field] !== undefined);
  const missing = {
    "source.changed": corpus.records.some((f) => ["capture", "extraction", "passage"].includes(String(f.data?.kind))),
    "quote.present": manuscript || someCitation("quotation") || has("note", "passage"),
    "quote.self": has("claim") && (manuscript || someCitation("quotation")),
    "locator.extent": manuscript || someCitation("locator"),
    "meta.source": used.length > 0 && has("capture"),
    "meta.resolver": manuscript || used.length > 0,
    "id.resolves": manuscript || used.some((s) => Array.isArray(s.data.identifiers) && s.data.identifiers.length > 0),
    "number.present": cited,
    "construct.credit": has("construct"),
    "claim.complete": has("claim"),
    "construct.complete": has("construct"),
    "claim.inactive": manuscript,
    "cite.unlinked": manuscript,
    "takeover.removal": has("round_choice"),
    "draft.marked": manuscript,
    "support.current": has("claim"),
    "restricted.leak": active(corpus, "place_location").some((f) => isObject(f.data.sensitivity) && f.data.sensitivity.class !== "public"),
    ...Object.fromEntries(["resolution", "alt", "credit", "permission", "vector", "font", "placement", "metadata"].map((n) => [`image.${n}`, has("image")])),
    "cite.format": false,
    "build.uncommitted": false,
    "changelog.missing": false,
    "package.leak": false
  };
  const entries = Object.entries(missing).map(([check, present]) => ({ check, reason: present ? "not_implemented" : "input_absent" }));
  if (corpus.records.some((f) => f.state === "ok" && !FULLY_CHECKED_KINDS.has(String(f.data?.kind)))) {
    entries.push({ check: "record.valid", reason: "not_implemented" });
  }
  if (manuscript)
    entries.push({ check: "source.held", reason: "not_implemented" });
  else if (citations.length === 0)
    entries.push({ check: "source.held", reason: "input_absent" });
  if (manuscript)
    entries.push({ check: "cite.key", reason: "not_implemented" });
  else if (citations.length === 0)
    entries.push({ check: "cite.key", reason: "input_absent" });
  if (manuscript && listedSources(corpus).length > 0)
    entries.push({ check: "bib.uncited", reason: "not_implemented" });
  else if (listedSources(corpus).length === 0)
    entries.push({ check: "bib.uncited", reason: "input_absent" });
  return entries.sort((a, b) => a.check < b.check ? -1 : a.check > b.check ? 1 : 0);
}
// packages/core/src/checks/coordinates.ts
var DECIMAL = String.raw`[-+\u2212]?\d{1,3}\.\d{3,}`;
var HEMI = (letters) => String.raw`\d{1,3}(?:\.\d+)?\s*\u00B0\s*(?:\d{1,2}(?:\.\d+)?\s*(?:\u2032|\u2019|')\s*)?(?:\d{1,2}(?:\.\d+)?\s*(?:\u2033|\u201D|\\"|")\s*)?[${letters}](?![A-Za-z])`;
var COORDINATE_FORMS = [
  /\bgeo:[-+]?\d+(?:\.\d+)?,[-+]?\d+(?:\.\d+)?/gi,
  new RegExp(`${HEMI("NSns")}[\\s,;/]*${HEMI("EWew")}`, "g"),
  new RegExp(`(?<![\\d.])(${DECIMAL})\xB0?\\s*,\\s*(${DECIMAL})(?![\\d]|\\.\\d)`, "g")
];
function findCoordinates(line) {
  const spans = [];
  for (const form of COORDINATE_FORMS) {
    for (const match of line.matchAll(form)) {
      if (match[1] !== undefined) {
        const [a, b] = [match[1], match[2]].map((v) => Math.abs(Number(v.replace("\u2212", "-"))));
        if (Math.max(a, b) > 180 || Math.min(a, b) > 90)
          continue;
      }
      const span = [match.index, match.index + match[0].length];
      if (!spans.some(([s, e]) => span[0] < e && s < span[1]))
        spans.push(span);
    }
  }
  return spans.map(([start]) => start).sort((a, b) => a - b);
}
function scannedFiles(corpus) {
  const files = [corpus.settings, ...corpus.records, ...corpus.rules ? [corpus.rules] : [], ...corpus.manuscript];
  return files.sort((a, b) => compareCodePoints(a.path, b.path));
}
function coordinateResults(corpus) {
  const check = "coordinate.stray";
  return scannedFiles(corpus).flatMap((file) => {
    const evidence = [{ name: "file", class: "location", value: file.path }];
    let text;
    try {
      if (!file.bytes)
        throw new Error("unreadable");
      text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    } catch {
      return [result({ check, outcome: "unverifiable", reason: "file_unreadable", subject: file.path, locus: file.path, evidence })];
    }
    const found = text.split(`
`).flatMap((line, i) => findCoordinates(line).map((column) => ({ line: i + 1, column: column + 1 })));
    if (found.length === 0)
      return [result({ check, outcome: "pass", subject: file.path, locus: file.path, evidence })];
    return found.map((at, ordinal) => result({
      check,
      outcome: "fail",
      reason: "coordinate_text",
      subject: file.path,
      locus: `${file.path}#${ordinal}`,
      evidence: [...evidence, { name: "position", class: "location", value: `line ${at.line}, column ${at.column}` }]
    }));
  });
}
// packages/core/src/render.ts
function groupResults(results) {
  const groups = new Map;
  for (const result of results) {
    const key = result.evidence.find((e) => e.name === "key" || e.name === "points_at");
    const cause = [result.check, result.reason_code ?? "", key?.value ?? ""].join("\x00");
    groups.set(cause, [...groups.get(cause) ?? [], result]);
  }
  return [...groups.values()];
}
var printable = (text) => text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "?");
function renderFindings(results) {
  const lines = [];
  groupResults(results.filter((r) => r.open)).forEach((group, i) => {
    const first = group[0];
    const verdict = first.outcome === "fail" ? "PROBLEM" : "COULD NOT CHECK";
    const places = group.length === 1 ? "" : `, ${group.length} places`;
    lines.push("", `${i + 1}. ${verdict}: ${first.message}  [${first.check}${places}]`, `   Why it matters: ${first.why}`);
    for (const suggestion of first.suggestions)
      lines.push(`   What to do: ${suggestion}`);
    for (const item of group) {
      lines.push(`   - ${printable(item.subject)}`);
      for (const e of item.evidence)
        lines.push(`       ${e.name.replaceAll("_", " ")}: ${printable(e.value)}`);
    }
  });
  return lines;
}
function renderReport(body) {
  const { summary } = body;
  const lines = [];
  if (body.label === "checked_clean") {
    lines.push("CHECKED CLEAN: the checks found nothing open.", "This does not mean that the book is correct. It covers only what is in these project files.");
  } else {
    const parts = [
      `${summary.fail} problem(s)`,
      `${summary.unverifiable} could not be checked`,
      `${summary.not_implemented} kind(s) of check this version does not run`
    ];
    lines.push(`OPEN FINDINGS: ${parts.join(", ")}. Nothing is blocked.`);
  }
  lines.push(`Checked the whole project: ${summary.pass} result(s) passed.`);
  lines.push(...renderFindings(body.results));
  const missing = body.not_run.filter((n) => n.reason === "not_implemented");
  if (missing.length > 0) {
    lines.push("", "NOT CHECKED: this version does not run these, so the project is not called checked clean.", "Why it matters: a mistake of one of these kinds would go unnoticed. What to do: check them by hand where they matter.");
    for (const entry of missing)
      lines.push(`   - ${CHECK_DESCRIPTIONS[entry.check]}  [${entry.check}]`);
  }
  if (body.unreviewed.length > 0) {
    lines.push("", `For information, not a finding: ${body.unreviewed.length} cited item(s) are unreviewed or not admitted.`);
    for (const item of body.unreviewed)
      lines.push(`   - ${item.record} (${item.reason.replace("_", " ")})`);
  }
  return `${lines.join(`
`)}
`;
}
// packages/core/src/store.ts
var NO_STORE = { verify: () => "missing", get: () => {
  return;
} };
var isDigest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
var BLOB_FIELDS = {
  "*": ["value_blob_sha256", "text_blob_sha256", "entry_text_blob_sha256"],
  capture: ["sha256"],
  extraction: ["text_sha256"],
  import_batch: ["original_sha256"],
  image: ["blob_sha256"],
  conversion: ["input_sha256", "output_sha256"]
};
function referencedBlobs(corpus) {
  const found = new Map;
  const add = (digest, path) => {
    if (isDigest(digest))
      found.set(digest, (found.get(digest) ?? new Set).add(path));
  };
  const walk = (value, path) => {
    if (Array.isArray(value))
      value.forEach((item) => walk(item, path));
    else if (isObject(value)) {
      for (const [name, item] of Object.entries(value)) {
        if (name === "x")
          continue;
        if (BLOB_FIELDS["*"].includes(name))
          add(item, path);
        else
          walk(item, path);
      }
    }
  };
  for (const file of corpus.records) {
    if (file.state !== "ok" || !file.data)
      continue;
    const kind = String(file.data.kind);
    for (const name of Object.hasOwn(BLOB_FIELDS, kind) && kind !== "*" ? BLOB_FIELDS[kind] : [])
      add(file.data[name], file.path);
    walk(file.data, file.path);
  }
  return new Map([...found].sort(([a], [b]) => compareCodePoints(a, b)).map(([d, paths]) => [d, [...paths].sort(compareCodePoints)]));
}
var unreadRecords = (corpus) => corpus.records.filter((f) => f.state !== "ok").map((f) => f.path);
function verifyStore(corpus, store, stored) {
  const referenced = referencedBlobs(corpus);
  const problems = [];
  for (const [sha256, named_by] of referenced) {
    const state = store.verify(sha256);
    if (state !== "ok")
      problems.push({ sha256, state, named_by });
  }
  return {
    referenced: referenced.size,
    intact: referenced.size - problems.length,
    problems,
    unread_records: unreadRecords(corpus),
    ...stored ? { unreferenced: stored.filter((d) => !referenced.has(d)).sort(compareCodePoints) } : {}
  };
}

// packages/core/src/checks/held.ts
var at = (name, value) => ({ name, class: "location", value });
var meta = (name, value) => ({ name, class: "metadata", value });
var unreadableIn2 = (corpus, ...directories) => corpus.records.some((f) => f.state !== "ok" && directories.some((d) => f.path.startsWith(`records/${d}/`)));
function fits(extraction, bytes) {
  const { text_size, page_spans } = extraction.data;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return "inconsistent";
  }
  if (text_size !== bytes.length)
    return "inconsistent";
  if (page_spans !== undefined && (!Array.isArray(page_spans) || checkPageSpans(page_spans, [...text].length).length > 0)) {
    return "inconsistent";
  }
  return /\S/u.test(text) ? "ok" : "empty";
}
function holding(corpus, source, blobs, read) {
  const captures = active(corpus, "capture").filter((c) => c.data.source === source);
  if (captures.length === 0) {
    return unreadableIn2(corpus, "captures") ? { outcome: "unverifiable", reason: "record_unreadable", evidence: [] } : { outcome: "fail", reason: "no_copy", evidence: [] };
  }
  const damage = [];
  let good;
  const bare = [];
  for (const capture of captures) {
    const sha = capture.data.sha256;
    const here = [at("capture_file", capture.path), ...isDigest(sha) ? [meta("copy_sha256", sha)] : []];
    const state = isDigest(sha) ? blobs.verify(sha) : "altered";
    if (state !== "ok") {
      damage.push({ reason: state === "altered" ? "copy_altered" : "copy_missing", evidence: here });
      continue;
    }
    if (capture.data.size !== blobs.get(sha)?.length) {
      damage.push({ reason: "copy_altered", evidence: [...here, meta("problem", "the recorded size differs from the stored file's size")] });
      continue;
    }
    read.add(sha);
    const extractions = active(corpus, "extraction").filter((e) => e.data.capture === idOf(capture) && e.data.capture_sha256 === sha);
    if (extractions.length === 0) {
      bare.push(...here);
      continue;
    }
    for (const extraction of extractions) {
      const textSha = extraction.data.text_sha256;
      const there = [...here, at("extraction_file", extraction.path), ...isDigest(textSha) ? [meta("text_sha256", textSha)] : []];
      const bytes = isDigest(textSha) ? blobs.get(textSha) : undefined;
      if (!bytes) {
        const textState = isDigest(textSha) ? blobs.verify(textSha) : "altered";
        damage.push({ reason: textState === "altered" ? "text_altered" : "text_missing", evidence: there });
        continue;
      }
      const state = fits(extraction, bytes);
      if (state === "inconsistent")
        damage.push({ reason: "text_inconsistent", evidence: there });
      else if (state === "empty")
        bare.push(...there, meta("problem", "the saved text holds no characters"));
      else {
        read.add(textSha);
        const quality = isObject(extraction.data.quality) ? extraction.data.quality : {};
        good ??= [...there, meta("text_method", `${String(quality.method)}, quality ${String(quality.level)}`)];
      }
    }
  }
  if (damage.length > 0)
    return { outcome: "unverifiable", reason: damage[0].reason, evidence: damage[0].evidence };
  if (good)
    return { outcome: "pass", evidence: good };
  return unreadableIn2(corpus, "extractions", "captures") ? { outcome: "unverifiable", reason: "record_unreadable", evidence: bare } : { outcome: "fail", reason: "no_text", evidence: bare };
}
function heldResults(corpus, blobs, read = new Set) {
  const check = "source.held";
  const seen = new Map;
  const of = (source) => {
    const known = seen.get(source) ?? holding(corpus, source, blobs, read);
    seen.set(source, known);
    return known;
  };
  const cited = new Set;
  const results = hasManuscript(corpus) ? [] : resolveCitations(corpus).flatMap(({ citation, key, matches }) => {
    if (matches.length !== 1)
      return [];
    const source = idOf(matches[0]);
    cited.add(source);
    const held = of(source);
    const data = citation.data;
    const sentence = isObject(data.sentence) && typeof data.sentence.text === "string" && typeof data.sentence.sha256 === "string" ? { text: data.sentence.text, sha256: data.sentence.sha256 } : undefined;
    const evidence = [
      at("citation_file", citation.path),
      meta("key", key ?? String(matches[0].data.citation_key ?? source)),
      at("source_file", matches[0].path),
      ...held.evidence
    ];
    return [result({
      check,
      outcome: held.outcome,
      ...held.reason ? { reason: held.reason } : {},
      subject: subjectOf(citation),
      locus: idOf(citation) ?? citation.path,
      source,
      evidence,
      item: itemOf(citation),
      ...sentence ? { sentence } : {}
    })];
  });
  for (const file of active(corpus, "source")) {
    const source = idOf(file);
    if (cited.has(source) || !active(corpus, "capture").some((c) => c.data.source === source))
      continue;
    const held = of(source);
    if (!held.reason?.endsWith("_altered") && held.reason !== "text_inconsistent")
      continue;
    results.push(result({
      check,
      outcome: held.outcome,
      reason: held.reason,
      subject: subjectOf(file),
      locus: "stored_copy",
      source,
      evidence: [at("source_file", file.path), meta("key", String(file.data.citation_key ?? source)), ...held.evidence],
      item: itemOf(file)
    }));
  }
  return results;
}

// packages/core/src/run.ts
function recordResults(corpus) {
  return [corpus.settings, ...corpus.records].flatMap(fileResults).concat(rulesResults(corpus));
}
function guarded(check, corpus, run, errors) {
  try {
    return run(corpus);
  } catch (error) {
    errors.push(`${check}: ${error instanceof Error ? error.message : "unknown error"}`);
    return [result({ check, outcome: "unverifiable", reason: "check_error", subject: "project", locus: "check" })];
  }
}
function unreviewedItems(corpus) {
  const reached = new Map;
  const add = (record, kind, reason, location) => {
    const entry = reached.get(record) ?? { record, kind, reason, locations: [] };
    if (!entry.locations.includes(location))
      entry.locations.push(location);
    reached.set(record, entry);
  };
  for (const { citation, matches } of resolveCitations(corpus)) {
    const location = idOf(citation) ?? citation.path;
    for (const source of matches) {
      if (source.data.admission !== "admitted")
        add(idOf(source), "source", "not_admitted", location);
    }
    const claims = citation.data.claims;
    for (const id of Array.isArray(claims) ? claims : []) {
      const claim = active(corpus, "claim").find((c) => idOf(c) === id);
      const review = claim?.data.review;
      if (claim && review?.state !== "reviewed")
        add(String(id), "claim", "unreviewed", location);
    }
  }
  return [...reached.values()].sort((a, b) => compareCodePoints(a.record, b.record));
}
function label(results, skipped) {
  return results.some((r) => r.open) || skipped.some((n) => n.reason === "not_implemented") ? "open_findings" : "checked_clean";
}
var IMPLEMENTED_CHECKS = {
  "record.valid": recordResults,
  "cite.key": citeKeyResults,
  "bib.uncited": uncitedResults,
  "source.held": heldResults,
  "coordinate.stray": coordinateResults
};
function runChecks(corpus, tools, blobs = NO_STORE) {
  const errors = [];
  const read = new Set;
  const results = sortResults(Object.entries(IMPLEMENTED_CHECKS).flatMap(([check, run]) => guarded(check, corpus, (c) => run(c, blobs, read), errors)));
  const skipped = notRun(corpus);
  const unreviewed = unreviewedItems(corpus);
  const count = (test) => results.filter(test).length;
  const summary = {
    pass: count((r) => r.outcome === "pass"),
    fail: count((r) => r.outcome === "fail"),
    unverifiable: count((r) => r.outcome === "unverifiable"),
    open: count((r) => r.open),
    dismissed: 0,
    confirmed: 0,
    unreviewed: unreviewed.length,
    could_not_check: count((r) => r.outcome === "unverifiable"),
    not_implemented: skipped.filter((n) => n.reason === "not_implemented").length
  };
  const body = {
    mode: "work",
    scope: "all",
    changed: [],
    inputs: {
      corpus_sha256: corpusDigest(corpus),
      manuscript: corpus.manuscript.map((f) => ({ path: f.path, sha256: f.bytes ? sha256(f.bytes) : "unreadable" })).sort((a, b) => compareCodePoints(a.path, b.path)),
      blobs: [...read].sort(),
      profiles: []
    },
    tools,
    results,
    not_run: skipped,
    unreviewed,
    redaction: "none",
    label: label(results, skipped),
    summary
  };
  return { body, errors };
}
// packages/core/src/operations.ts
class InvalidInput extends Error {
}

class ActorNeeded extends Error {
}
function prepareRecord(request) {
  const { kind } = request;
  let parsed;
  try {
    parsed = parseJson(request.input);
  } catch (error) {
    if (error instanceof JsonUnreadable)
      throw new InvalidInput(`The input is not usable JSON (${error.problem}).`);
    throw error;
  }
  const record = parsed.value;
  if (!isObject(record))
    throw new InvalidInput("The input must be one JSON object.");
  if (parsed.forbidden.some((f) => f.problem === "number_not_integer")) {
    throw new InvalidInput(`Writing it would change a value: ${PROBLEMS.number_not_integer}.`);
  }
  if (record.kind !== undefined && record.kind !== kind)
    throw new InvalidInput(`The input's kind is not ${kind}.`);
  const id = record.id ?? `${KINDS[kind].prefix}${request.token()}`;
  if (typeof id !== "string" || !isRecordId(kind, id)) {
    throw new InvalidInput(`The id must be ${KINDS[kind].prefix} followed by 8 to 40 lowercase letters or digits.`);
  }
  record.schema ??= RECORD_SCHEMA;
  record.kind = kind;
  record.id = id;
  if (record.created === undefined) {
    if (!request.actor)
      throw new ActorNeeded;
    record.created = { at: request.now.toISOString().replace(/\.\d+Z$/, "Z"), by: { ...request.actor } };
  }
  if (kind === "source")
    record.admission ??= "candidate";
  if (kind === "source" || kind === "citation")
    record.intake ??= "parsed";
  const sentence = record.sentence;
  if (kind === "citation" && isObject(sentence) && typeof sentence.text === "string" && sentence.sha256 === undefined) {
    sentence.text = normalizeSentence(sentence.text);
    sentence.sha256 = sha256(sentence.text);
  }
  return { id, path: recordPath(kind, id), text: canonical(record) };
}
function formatPlan(corpus, wanted) {
  return [corpus.settings, ...corpus.records].flatMap((file) => {
    if (!wanted.has(file.path) || file.state !== "ok" || !file.formattable || !file.data)
      return [];
    const text = canonical(file.data);
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(file.bytes) === text ? [] : [{ path: file.path, text }];
  });
}
var fileOf = (result) => result.evidence.find((e) => e.name === "file")?.value ?? result.subject;
function validateFiles(corpus, wanted) {
  return recordResults(corpus).filter((r) => wanted.has(fileOf(r)));
}
// packages/core/src/sources.ts
var LIMITS = { input_bytes: 500 * 1024 * 1024, pages: 5000, text_bytes: 100 * 1024 * 1024, page_map_bytes: 5 * 1024 * 1024 };
var TEXT_PROFILE = "utf8-lf/0";
var stamp = (actor, now) => ({ at: now.toISOString().replace(/\.\d+Z$/, "Z"), by: { ...actor } });
var write2 = (kind, record) => {
  const id = record.id;
  return { id, path: recordPath(kind, id), text: canonical(record) };
};
var fresh = (kind, token, actor, now) => ({ schema: RECORD_SCHEMA, id: `${KINDS[kind].prefix}${token()}`, kind, created: stamp(actor, now) });

class DuplicateCopy extends Error {
  holders;
  constructor(holders) {
    super("duplicate copy");
    this.holders = holders;
  }
}
function sourceRecord(corpus, id) {
  const file = corpus.byId.get(id);
  if (!isRecordId("source", id) || file?.data?.kind !== "source")
    throw new InvalidInput(`No readable source record has the ID ${id}.`);
  if (isRetired(file.data))
    throw new InvalidInput(`The source ${id} is retired.`);
  if (!file.formattable)
    throw new InvalidInput(`${file.path} holds values that rewriting would change. Correct it first.`);
  return file.data;
}
function planAddSource(corpus, request) {
  const { actor, now, token } = request;
  const named = request.source === undefined ? undefined : sourceRecord(corpus, request.source);
  const holders = corpus.records.filter((f) => f.state === "ok" && f.data?.kind === "capture" && !isRetired(f.data) && f.data.sha256 === request.sha256).map((f) => ({ source: String(f.data.source), capture: idOf(f) }));
  const own = holders.find((h) => h.source === request.source);
  const rights = Object.fromEntries(Object.entries(request.rights).filter(([, v]) => v !== undefined));
  const changesRights = Object.keys(rights).length > 0;
  if (!named && holders.length > 0)
    throw new DuplicateCopy(holders);
  const records = [];
  const source = request.source ?? `${KINDS.source.prefix}${token()}`;
  if (!named) {
    records.push(write2("source", {
      schema: RECORD_SCHEMA,
      id: source,
      kind: "source",
      created: stamp(actor, now),
      admission: "candidate",
      intake: "raw",
      ...changesRights ? { rights } : {}
    }));
  } else if (changesRights) {
    const before = isObject(named.rights) ? named.rights : {};
    records.push(write2("source", { ...named, rights: { ...before, ...rights }, changed: stamp(actor, now) }));
  }
  if (own)
    return { state: "already_held", source, capture: own.capture, records };
  const capture = write2("capture", {
    ...fresh("capture", token, actor, now),
    source,
    sha256: request.sha256,
    size: request.size,
    media_type: request.media_type,
    origin: request.origin ?? "unknown",
    acquired_at: request.acquired_at,
    ...request.source_version === undefined ? {} : { source_version: request.source_version },
    admitted_by: { ...actor }
  });
  assertValid("Capture", "capture", capture);
  return { state: "add", source, new_source: !named, capture, records: [...records, capture] };
}
function assertValid(type, kind, record) {
  const problems = [];
  checkShape(type, parseJson(record.text).value, "", kind, problems, []);
  if (problems.length > 0) {
    throw new InvalidInput(`These values do not make a valid ${kind} record (${problems.map((p) => `${p.code} at ${p.field}`).join(", ")}).`);
  }
}
var decode = (bytes, what) => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new InvalidInput(`${what} is not valid UTF-8 text.`);
  }
};
var normalizeText = (text) => text.replace(/^\uFEFF/, "").replace(/\r\n?/g, `
`);
function pageSpans(text) {
  const pages = text.split("\f");
  if (pages.length > 1 && !/\S/u.test(pages.at(-1)))
    pages.pop();
  let start = 0;
  return pages.map((page, page_index) => {
    const length = [...page].length;
    const span = { page_index, start, end: start + length };
    start += length + 1;
    return span;
  });
}
function parsePageMap(bytes, pageCount) {
  if (bytes.length > LIMITS.page_map_bytes)
    throw new InvalidInput("The page map is larger than the limit of 5 MiB.");
  let value;
  try {
    value = parseJson(decode(bytes, "The page map")).value;
  } catch (error) {
    if (error instanceof JsonUnreadable)
      throw new InvalidInput(`The page map is not usable JSON (${error.problem}).`);
    throw error;
  }
  if (!Array.isArray(value))
    throw new InvalidInput("The page map must be a JSON list of page segments.");
  const problems = [];
  value.forEach((segment, i) => checkShape("PageSegment", segment, `/${i}`, "extraction.pages", problems, []));
  const codes = [
    ...problems.map((p) => `${p.code} at ${p.field}`),
    ...checkPageSegments(value).map((p) => `${p.code} at /${p.index}`)
  ];
  const segments = value;
  if (codes.length === 0 && segments.some((s) => s.last_index >= pageCount))
    codes.push("a segment ends beyond the last page of the text");
  if (codes.length > 0)
    throw new InvalidInput(`The page map cannot be used: ${codes.join("; ")}.`);
  return segments;
}

class NoExtractor extends Error {
}
function planSourceText(corpus, request) {
  const capture = corpus.byId.get(request.capture)?.data;
  if (capture?.kind !== "capture")
    throw new InvalidInput(`No readable capture record has the ID ${request.capture}.`);
  if (isRetired(capture))
    throw new InvalidInput(`The capture ${request.capture} is retired.`);
  const plain = capture.media_type === "text/plain";
  if (plain && request.layer)
    throw new InvalidInput("This copy is plain text, so it is read as it is. Leave out --text-layer.");
  if (plain && (request.method || request.tool))
    throw new InvalidInput("--method, --tool and --tool-version describe a supplied text layer.");
  if (!plain && !request.layer)
    throw new NoExtractor;
  const bytes = request.layer ?? request.copy;
  if (bytes.length > LIMITS.text_bytes)
    throw new InvalidInput("The text is larger than the limit of 100 MiB.");
  const text = normalizeText(decode(bytes, request.layer ? "The text layer" : "The copy"));
  if (text.includes("\x00"))
    throw new InvalidInput("The text holds a NUL character, so it is not usable text.");
  if (!/\S/u.test(text)) {
    throw new InvalidInput("There is no machine-readable text: it is empty or only white space. No extraction was saved, and this copy does not count as checkable.");
  }
  const spans = !plain || text.includes("\f") ? pageSpans(text) : undefined;
  if ((spans?.length ?? 0) > LIMITS.pages)
    throw new InvalidInput("The text has more than the limit of 5,000 pages.");
  if (request.pageMap && !spans)
    throw new InvalidInput("This text has no page breaks, so there are no pages to label.");
  const pages = request.pageMap ? parsePageMap(request.pageMap, spans.length) : undefined;
  const encoded = new TextEncoder().encode(text);
  const method = plain ? "born_text" : request.method ?? "text_layer";
  const record = write2("extraction", {
    ...fresh("extraction", request.token, request.actor, request.now),
    capture: request.capture,
    capture_sha256: capture.sha256,
    tool: plain ? { name: "stemma", version: request.stemma } : request.tool ?? { name: "unknown", version: "unknown" },
    normalization_profile: TEXT_PROFILE,
    text_sha256: sha256(encoded),
    text_size: encoded.length,
    ...pages ? { pages } : {},
    ...spans ? { page_spans: spans } : {},
    quality: { method, level: "unassessed", ...request.note ? { note: request.note } : {} }
  });
  assertValid("Extraction", "extraction", record);
  const labels = pageLabels(pages ?? []);
  return {
    record,
    text: encoded,
    text_sha256: sha256(encoded),
    method,
    pages: spans?.length ?? 0,
    unmapped: (spans ?? []).map((s) => s.page_index).filter((i) => !labels.has(i))
  };
}
function ranges(indexes) {
  const out = [];
  for (const i of indexes) {
    const last = out.at(-1);
    if (last && i === last[1] + 1)
      last[1] = i;
    else
      out.push([i, i]);
  }
  return out.map(([a, b]) => a === b ? `${a}` : `${a}-${b}`).join(", ");
}
// packages/workspace/src/index.ts
import { randomBytes as randomBytes2 } from "crypto";
import { appendFileSync, existsSync as existsSync2, lstatSync as lstatSync2, mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync2, realpathSync as realpathSync2, renameSync as renameSync2, rmSync as rmSync2, writeFileSync } from "fs";
import { dirname as dirname2, isAbsolute as isAbsolute2, join as join2, relative as relative2, resolve as resolve2, sep as sep2 } from "path";

// packages/workspace/src/store.ts
import { createHash as createHash2, randomBytes } from "crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";

class UnsafeStore extends Error {
}
function storeLocation(root, projectId, option, env = process.env) {
  if (option)
    return { path: resolve(root, option), chosen_by: "--store-dir" };
  if (env.STEMMA_STORE_DIR)
    return { path: resolve(root, env.STEMMA_STORE_DIR), chosen_by: "STEMMA_STORE_DIR" };
  if (typeof projectId !== "string" || !/^[0-9a-z]{8,40}$/.test(projectId)) {
    throw new UnsafeStore("project_id in stemma.json cannot form a directory name; name the store with --store-dir.");
  }
  const home = env.HOME || homedir();
  const base = process.platform === "darwin" ? join(home, "Library/Application Support") : process.platform === "win32" ? env.LOCALAPPDATA || join(home, "AppData/Local") : env.XDG_DATA_HOME || join(home, ".local/share");
  return { path: join(base, "stemma", "stores", projectId), chosen_by: "default" };
}
function realTarget(path) {
  const missing = [];
  let at = resolve(path);
  while (!existsSync(at) && dirname(at) !== at) {
    missing.unshift(basename(at));
    at = dirname(at);
  }
  return join(realpathSync(at), ...missing);
}
var within = (outer, path) => {
  const rel = relative(outer, path);
  return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};
function gitIgnores(tree, path) {
  const git = (...args) => {
    try {
      return Bun.spawnSync(["git", "-c", "core.fsmonitor=false", "-C", tree, ...args], { stdout: "pipe", stderr: "pipe" });
    } catch {
      return;
    }
  };
  const rel = relative(tree, path);
  if (rel === "")
    return false;
  const ignored = git("check-ignore", "--quiet", "--", join(rel, "sha256", "probe"));
  const tracked = git("ls-files", "-z", "--", rel);
  return ignored?.exitCode === 0 && tracked?.exitCode === 0 && tracked.stdout.length === 0;
}
function storeProblem(root, path) {
  const target = realTarget(path);
  const project = realpathSync(root);
  if (within(project, target))
    return "it is inside the project directory. The store is private and kept apart from the project";
  if (within(target, project))
    return "the project is inside it";
  if (existsSync(target) && !statSync(target).isDirectory())
    return "it is not a directory";
  for (let at = target;; at = dirname(at)) {
    if (existsSync(join(at, ".git")) && !gitIgnores(at, target)) {
      return "it is inside a git working tree that does not ignore it (or git could not be asked), so copies of sources could be committed";
    }
    if (dirname(at) === at)
      return;
  }
}
var CHUNK = 1 << 20;
function hashFile(path, sink) {
  const handle = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(handle).isFile())
      throw new Error("not a regular file");
    const hash = createHash2("sha256");
    const buffer = new Uint8Array(CHUNK);
    let size = 0;
    for (let read;(read = readSync(handle, buffer, 0, CHUNK, null)) > 0; ) {
      const chunk = buffer.subarray(0, read);
      hash.update(chunk);
      sink?.(chunk);
      size += read;
    }
    return { sha256: hash.digest("hex"), size };
  } finally {
    closeSync(handle);
  }
}

class UnsupportedFile extends Error {
}
function inspectSourceFile(path, limit) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new UnsupportedFile("The file cannot be read.");
  }
  if (!stat.isFile())
    throw new UnsupportedFile("That is not a regular file.");
  if (stat.size > limit)
    throw new UnsupportedFile(`The file is larger than the limit of ${limit / 1024 / 1024} MiB.`);
  if (stat.size === 0)
    throw new UnsupportedFile("The file is empty.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let head = "";
  let pdf;
  let text = true;
  const found = hashFile(path, (chunk) => {
    pdf ??= new TextDecoder("latin1").decode(chunk.subarray(0, 5)) === "%PDF-";
    if (pdf || !text)
      return;
    try {
      const piece = decoder.decode(chunk, { stream: true });
      if (head.length < 200)
        head += piece.slice(0, 200);
      if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(piece))
        text = false;
    } catch {
      text = false;
    }
  });
  if (found.size > limit)
    throw new UnsupportedFile("The file grew past the limit while it was read.");
  if (pdf)
    return { media_type: "application/pdf", ...found };
  if (text) {
    try {
      decoder.decode();
    } catch {
      text = false;
    }
  }
  const markup = /^\uFEFF?\s*(<!doctype html|<html|\{\\rtf)/i.test(head);
  if (!text || markup) {
    throw new UnsupportedFile("This version takes PDF files and plain UTF-8 text only; this file is neither. Nothing was stored, and no source is marked as checked.");
  }
  return { media_type: "text/plain", ...found };
}

class BlobStore {
  root;
  constructor(root) {
    this.root = root;
  }
  address(digest) {
    if (!/^[0-9a-f]{64}$/.test(digest))
      throw new Error("not a digest");
    return join(this.root, "sha256", digest.slice(0, 2), digest);
  }
  plain(digest) {
    const path = this.address(digest);
    try {
      for (const directory of [dirname(dirname(path)), dirname(path)]) {
        if (!lstatSync(directory).isDirectory())
          return "unreadable";
      }
      return lstatSync(path).isFile() ? "present" : "unreadable";
    } catch (error) {
      return error.code === "ENOENT" ? "missing" : "unreadable";
    }
  }
  has(digest) {
    return this.plain(digest) === "present";
  }
  verify(digest) {
    const state = this.plain(digest);
    if (state !== "present")
      return state;
    try {
      return hashFile(this.address(digest)).sha256 === digest ? "ok" : "altered";
    } catch {
      return "unreadable";
    }
  }
  get(digest) {
    if (this.plain(digest) !== "present")
      return;
    try {
      const bytes = new Uint8Array(readFileSync(this.address(digest)));
      return createHash2("sha256").update(bytes).digest("hex") === digest ? bytes : undefined;
    } catch {
      return;
    }
  }
  put(from, digest) {
    const target = this.address(digest);
    const before = this.verify(digest);
    if (before === "ok")
      return "present";
    const temporary = join(this.root, "tmp", randomBytes(12).toString("hex"));
    for (const directory of [this.root, join(this.root, "tmp"), join(this.root, "sha256"), dirname(target)]) {
      mkdirSync(directory, { recursive: true, mode: 448 });
      if (directory !== this.root && !lstatSync(directory).isDirectory())
        throw new UnsafeStore(`${directory} is not a plain directory.`);
    }
    try {
      const handle = openSync(temporary, "wx", 384);
      try {
        const out = (chunk) => {
          for (let done = 0;done < chunk.length; )
            done += writeSync(handle, chunk, done);
        };
        if ("file" in from)
          hashFile(from.file, out);
        else
          out(from.bytes);
      } finally {
        closeSync(handle);
      }
      if (hashFile(temporary).sha256 !== digest)
        throw new Error("the bytes changed while they were being stored");
      chmodSync(temporary, 384);
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
    return before === "missing" ? "stored" : "restored";
  }
  list() {
    const top = join(this.root, "sha256");
    const names = (path) => {
      try {
        return lstatSync(path).isDirectory() ? readdirSync(path) : [];
      } catch {
        return [];
      }
    };
    return names(top).flatMap((two) => names(join(top, two)).filter((n) => /^[0-9a-f]{64}$/.test(n) && n.startsWith(two))).sort();
  }
}

// packages/workspace/src/index.ts
function findProject(start) {
  for (let dir = resolve2(start);; dir = dirname2(dir)) {
    if (existsSync2(join2(dir, "stemma.json")))
      return dir;
    if (dirname2(dir) === dir)
      return;
  }
}
function sourceFile(root, path) {
  const full = join2(root, path);
  try {
    if (!lstatSync2(full).isFile())
      return { path };
    return { path, bytes: new Uint8Array(readFileSync2(full)) };
  } catch {
    return { path };
  }
}
function listFiles(root, directory) {
  let stat;
  try {
    stat = lstatSync2(join2(root, directory));
  } catch {
    return [];
  }
  if (!stat.isDirectory())
    return [{ path: directory }];
  let names;
  try {
    names = readdirSync2(join2(root, directory));
  } catch {
    return [{ path: directory }];
  }
  return names.filter((name) => !name.startsWith(".")).flatMap((name) => {
    const path = `${directory}/${name}`;
    const entry = lstatSync2(join2(root, path));
    return entry.isDirectory() ? listFiles(root, path) : [sourceFile(root, path)];
  });
}
function readProject(root) {
  const content = {
    settings: sourceFile(root, "stemma.json"),
    records: listFiles(root, "records"),
    manuscript: listFiles(root, "manuscript")
  };
  if (existsSync2(join2(root, "rules.md")))
    content.rules = sourceFile(root, "rules.md");
  return content;
}

class UnsafePath extends Error {
}
var inside = (root, path) => {
  const rel = relative2(root, path);
  return rel === "" || !isAbsolute2(rel) && rel !== ".." && !rel.startsWith(`..${sep2}`);
};
function projectRelative(root, path) {
  const full = resolve2(root, path);
  const real = existsSync2(full) ? realpathSync2(full) : full;
  const base = inside(root, full) ? root : realpathSync2(root);
  const target = inside(root, full) ? full : real;
  if (!inside(base, target))
    throw new UnsafePath(path);
  return relative2(base, target).split(sep2).join("/");
}
function safeTarget(root, path) {
  const full = resolve2(root, path);
  if (!inside(root, full))
    throw new UnsafePath(path);
  let parent = dirname2(full);
  while (!existsSync2(parent))
    parent = dirname2(parent);
  if (!inside(realpathSync2(root), realpathSync2(parent)))
    throw new UnsafePath(path);
  try {
    if (!lstatSync2(full).isFile())
      throw new UnsafePath(path);
  } catch (error) {
    if (error instanceof UnsafePath)
      throw error;
  }
  return full;
}
function writeProjectFile(root, path, text) {
  const full = safeTarget(root, path);
  mkdirSync2(dirname2(full), { recursive: true });
  const temporary = `${full}.${randomBytes2(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: "wx" });
    renameSync2(temporary, full);
  } finally {
    rmSync2(temporary, { force: true });
  }
}
var BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
var randomToken = () => Array.from(randomBytes2(20), (byte) => BASE32[byte % 32]).join("");
var RULES = `# Standing rules

Write each rule under a level-two heading with a number that is never reused,
for example "RULE-001 Spell the town as the charter does".
`;
var ATTRIBUTES = ["stemma.json", "rules.md", "records/**", "manuscript/**"].map((p) => `${p} text eol=lf`);
var IGNORED = [".stemma/", "build/"];
function addLines(root, path, lines) {
  const full = safeTarget(root, path);
  const present = existsSync2(full) ? readFileSync2(full, "utf8") : "";
  const have = new Set(present.split(/\r?\n/));
  const missing = lines.filter((line) => !have.has(line));
  if (missing.length === 0)
    return false;
  appendFileSync(full, `${present && !present.endsWith(`
`) ? `
` : ""}${missing.join(`
`)}
`);
  return true;
}

class AlreadyInitialized extends Error {
}
function initProject(root) {
  if (existsSync2(join2(root, "stemma.json")))
    throw new AlreadyInitialized(root);
  mkdirSync2(join2(root, "records"), { recursive: true });
  mkdirSync2(join2(root, "manuscript"), { recursive: true });
  const project_id = randomToken();
  const written = [];
  if (!existsSync2(join2(root, "rules.md"))) {
    writeProjectFile(root, "rules.md", RULES);
    written.push("rules.md");
  }
  if (addLines(root, ".gitattributes", ATTRIBUTES))
    written.push(".gitattributes");
  if (addLines(root, ".gitignore", IGNORED))
    written.push(".gitignore");
  writeProjectFile(root, "stemma.json", canonical({ schema: PROJECT_SCHEMA, project_id, format: PROJECT_FORMAT }));
  written.push("stemma.json");
  return { project_id, written };
}
// .claude-plugin/plugin.json
var plugin_default = {
  name: "stemma",
  version: "0.0.1",
  description: "Research and write books with citations checked by scripts against your own stored copies, with plain-language reports. Claude sets up what the plugin needs.",
  author: {
    name: "DocumentDrivenDX",
    url: "https://github.com/DocumentDrivenDX"
  },
  homepage: "https://github.com/DocumentDrivenDX/stemma",
  repository: "https://github.com/DocumentDrivenDX/stemma",
  license: "MIT",
  skills: "./skills/"
};

// packages/cli/src/runtime.ts
var PINNED_BUN = "1.4.5";
var ISOLATION_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"];
var LAUNCHER_HELP = `Run it through the plugin's launcher, scripts/stemma.sh, which fetches and uses Bun ${PINNED_BUN}. Nothing was checked.`;
function runtimeProblem(version, flags) {
  if (version !== PINNED_BUN)
    return `This is Bun ${version}; Stemma needs Bun ${PINNED_BUN}. ${LAUNCHER_HELP}`;
  if (!flags.includes("--no-install")) {
    return `Bun was started without --no-install, so it could download packages while running. Start it as: bun ${ISOLATION_FLAGS.join(" ")} <plugin root>/dist/stemma.js. Nothing was checked.`;
  }
  return;
}

// packages/cli/src/main.ts
var VERSION = plugin_default.version;
var REPORT_PATH = ".stemma/reports/check.json";
var USAGE = `stemma ${VERSION}
The plugin runs this through its launcher: sh scripts/stemma.sh <data directory> <command> [options]

  version
  doctor
  init --project <dir>
  record add <kind> --input <file|-> [--actor <person|model|software>:<name>]
  validate [paths]
  fmt [paths]
  rules check
  check [--changed | --all]
  source add <file> --acquired-at <time> --actor <kind>:<name> [--source <id>] [--origin <text>]
             [--source-version <text>] [--unpublished yes|no] [--community-restricted yes|no] [--license <text>]
  source text <capture id> --actor <kind>:<name> [--text-layer <file>] [--page-map <file>]
             [--method text_layer|ocr|manual] [--tool <name> --tool-version <version>] [--note <text>]
  store verify [--unreferenced]

Options: --project <dir> (default: nearest ancestor holding stemma.json), --format text|json,
--store-dir <dir> (private content store; else STEMMA_STORE_DIR, else a per-user directory)
Exit codes: 0 done, nothing open; 1 done, findings open; 2 usage or not implemented;
3 project unreadable; 4 wrong runtime; 5 request not valid; 70 internal error.
`;
var NOT_YET = new Set([
  "migrate",
  "capture",
  "key",
  "resolve",
  "excerpt",
  "unreviewed",
  "reviewed",
  "retire",
  "rounds",
  "review",
  "support",
  "annotate",
  "import",
  "export",
  "takeover",
  "index",
  "research",
  "setup",
  "log",
  "activity",
  "plan",
  "voice",
  "audit",
  "checkpoint",
  "authorship",
  "restricted",
  "build",
  "disclosure",
  "scan",
  "graph",
  "map"
]);

class CommandError extends Error {
  exit;
  code;
  paths;
  constructor(exit, code, message, paths = []) {
    super(message);
    this.exit = exit;
    this.code = code;
    this.paths = paths;
  }
}
var usage = (message) => new CommandError(2, "usage", `${message}

${USAGE}`);
var COMMAND_OPTIONS = {
  "source add": ["actor", "source", "origin", "acquired-at", "source-version", "unpublished", "community-restricted", "license"],
  "source text": ["actor", "text-layer", "page-map", "method", "tool", "tool-version", "note"],
  "store verify": ["unreferenced"],
  "record add": ["actor", "input"],
  check: ["changed", "all"]
};
function emit(options, json, text) {
  process.stdout.write(options.format === "json" ? canonical(json) : text);
}
function requireProject(options) {
  const root = options.project ? resolve3(options.project) : findProject(process.cwd());
  if (!root)
    throw new CommandError(3, "no_project", "No stemma.json was found here or above. Pass --project <dir>, or run init.");
  return root;
}
function openCorpus(root) {
  const corpus = loadCorpus(readProject(root));
  const { state, data } = corpus.settings;
  if (state === "version_unsupported") {
    throw new CommandError(3, "version_unsupported", "stemma.json was written by a newer Stemma. Update Stemma; nothing was changed.", ["stemma.json"]);
  }
  if (!data) {
    throw new CommandError(3, "project_unreadable", "stemma.json is missing or cannot be read as JSON, so nothing was checked.", ["stemma.json"]);
  }
  return corpus;
}
var sqliteVersion = () => {
  const database = new Database(":memory:");
  try {
    return database.query("select sqlite_version() as v").get().v;
  } finally {
    database.close();
  }
};
var tools = () => ({ stemma: VERSION, bun: Bun.version, sqlite: sqliteVersion() });
function version(options) {
  emit(options, { stemma: VERSION, bun_pinned: PINNED_BUN }, `stemma ${VERSION} (needs Bun ${PINNED_BUN})
`);
  return 0;
}
function storeLines(store) {
  if ("note" in store)
    return [`Content store: ${store.note}`];
  return [
    `Content store: ${store.path} (chosen by ${store.chosen_by}; ${store.exists ? "present" : "not created yet"})`,
    ...store.refused ? [`WARNING: this location is refused: ${store.refused}.`] : [],
    `Stored files: ${store.blobs_present} of ${store.blobs_named} that records name are present (not hashed here; \`store verify\` does that).${store.unread_records ? ` ${store.unread_records} record file(s) cannot be read.` : ""}`,
    BACKUP_NOTICE
  ];
}
function gitVersion() {
  try {
    const done = Bun.spawnSync(["git", "--version"]);
    if (done.exitCode === 0)
      return `Besides Bun, ${done.stdout.toString().trim()} is asked only whether a content store inside a git working tree is ignored.`;
  } catch {}
  return "git was not found. Besides Bun it is used only for a content store inside a git working tree, which is then refused.";
}
function doctor(options) {
  const flags = Object.fromEntries(ISOLATION_FLAGS.map((f) => [f, process.execArgv.includes(f)]));
  const project = options.project ? resolve3(options.project) : findProject(process.cwd());
  const info = {
    ...tools(),
    bun_pinned: PINNED_BUN,
    bun_path: process.execPath,
    bundle_path: Bun.main,
    working_directory: process.cwd(),
    project: project ?? "",
    start_flags: flags,
    platform: `${process.platform}-${process.arch}`,
    platform_status: "Development tests have run on macOS (Apple silicon) only. No release has been observed on any system; other systems and desktop apps are untested.",
    external_tools: gitVersion(),
    source_limits: LIMITS,
    store: project && existsSync3(join3(project, "stemma.json")) ? storeStatus(project, options) : { note: "No project, so no content store." }
  };
  const missing = ISOLATION_FLAGS.filter((f) => !flags[f]);
  const lines = [
    `stemma ${info.stemma}`,
    `Bun ${info.bun} (pinned ${PINNED_BUN}) at ${info.bun_path}`,
    `SQLite ${info.sqlite}`,
    `Command line: ${info.bundle_path}`,
    `Working directory: ${info.working_directory}`,
    `Project: ${info.project || "none found"}`,
    `Platform: ${info.platform}. ${info.platform_status}`,
    info.external_tools,
    ...storeLines(info.store),
    `Limits on added files: ${LIMITS.input_bytes / 1048576} MiB for a copy, ${LIMITS.text_bytes / 1048576} MiB and ${LIMITS.pages} pages for its text.`,
    missing.length === 0 ? "Start flags: no run-time downloads, and no .env or bunfig.toml is loaded." : `WARNING: started without ${missing.join(" ")}. A .env or bunfig.toml in the working directory could run code or change settings.`
  ];
  emit(options, info, `${lines.join(`
`)}
`);
  return 0;
}
function init(options) {
  if (!options.project)
    throw usage("init needs --project <dir>.");
  const root = resolve3(options.project);
  const made = initProject(root);
  emit(options, { project: root, ...made }, `Created a Stemma project in ${root}
${made.written.map((f) => `  wrote ${f}`).join(`
`)}
`);
  return 0;
}
function reportRecords(options, results, head, extra) {
  const open = results.filter((r) => r.open);
  const body = open.length === 0 ? `No record problems found.
` : `${open.length} record problem(s). Nothing is blocked.${renderFindings(results).join(`
`)}
`;
  emit(options, { ...extra, results }, `${head}${body}`);
  return open.length > 0 ? 1 : 0;
}
function actorOf(options) {
  const named = /^(person|model|software):(.+)$/.exec(options.actor ?? "");
  if (options.actor !== undefined && !named)
    throw usage("--actor is person:<name>, model:<name> or software:<name>.");
  return named ? { kind: named[1], name: named[2] } : undefined;
}
var unsafeStore = (path, why) => new CommandError(5, "unsafe_store", `The content store cannot be ${path}: ${why}. Nothing was stored or read there.`, [path]);
function openStore(root, corpus, options) {
  const location = storeLocation(root, corpus.settings.data?.project_id, options["store-dir"]);
  const why = storeProblem(root, location.path);
  if (why)
    throw unsafeStore(location.path, why);
  return { store: new BlobStore(location.path), ...location };
}
var BACKUP_NOTICE = "The content store is private, apart from the repository, and Stemma never copies it anywhere: backing it up is your task.";
var MODEL_NOTICE = "Stemma holds back no source: any source in this project may be sent to a hosted model.";
function sourceAdd(options, file) {
  if (!file)
    throw usage("source add needs a file.");
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(file)) {
    throw new CommandError(2, "not_implemented", "Adding from a web address is not implemented in this version. Nothing was fetched. Add a file instead.");
  }
  const actor = actorOf(options);
  if (!actor)
    throw usage("source add records who added the copy: give --actor.");
  if (!options["acquired-at"]) {
    throw usage("source add records when you got the copy and does not guess it: give --acquired-at, for example 2026-01-05T09:58:00Z.");
  }
  const flag = (name) => {
    const value = options[name];
    if (value !== undefined && value !== "yes" && value !== "no")
      throw usage(`--${name} is yes or no.`);
    return value === undefined ? undefined : value === "yes";
  };
  const rights = { unpublished: flag("unpublished"), community_restricted: flag("community-restricted"), license: options.license };
  const root = requireProject(options);
  const corpus = openCorpus(root);
  const { store, path } = openStore(root, corpus, options);
  const from = resolve3(root, file);
  const found = inspectSourceFile(from, LIMITS.input_bytes);
  const plan = planAddSource(corpus, {
    ...found,
    acquired_at: options["acquired-at"],
    rights: Object.fromEntries(Object.entries(rights).filter(([, v]) => v !== undefined)),
    ...options.source === undefined ? {} : { source: options.source },
    ...options.origin === undefined ? {} : { origin: options.origin },
    ...options["source-version"] === undefined ? {} : { source_version: options["source-version"] },
    actor,
    now: new Date,
    token: randomToken
  });
  const existing = new Set(readProject(root).records.map((f) => f.path));
  if (plan.state === "add" && existing.has(plan.capture.path))
    throw new InvalidInput(`${plan.capture.path} already exists.`);
  const stored = store.put({ file: from }, found.sha256);
  for (const record of plan.records)
    writeProjectFile(root, record.path, record.text);
  const capture = plan.state === "add" ? plan.capture.id : plan.capture;
  const wrote = new Set(plan.records.map((r) => r.path));
  const results = validateFiles(openCorpus(root), wrote);
  const head = [
    plan.state === "add" ? `Stored the copy and recorded it as ${capture}.` : `This source already has this copy (${capture}); no second record was written.`,
    `  source: ${plan.source}${plan.state === "add" && plan.new_source ? " (new, a candidate; it has no citation key yet)" : ""}`,
    `  sha256: ${found.sha256} (${found.size} bytes, ${found.media_type})`,
    `  store: ${path} (${stored === "present" ? "already held these bytes" : stored === "restored" ? "a damaged blob was replaced by matching bytes" : "stored and verified"})`,
    ...plan.state === "add" ? [
      `  origin: ${options.origin ?? "unknown"}`,
      `  acquired at: ${options["acquired-at"]}`,
      `  version: ${options["source-version"] ?? "unknown"}`,
      `  added by: ${actor.kind} ${actor.name} (a record of what was said, not proof)`
    ] : [],
    ...plan.records.map((r) => `  wrote ${r.path}`),
    BACKUP_NOTICE,
    MODEL_NOTICE,
    `Next: attach its text with \`source text ${capture}\`.`
  ].join(`
`);
  return reportRecords(options, results, `${head}
`, {
    source: plan.source,
    capture,
    state: plan.state,
    store: path,
    blob: stored,
    ...found,
    notices: [BACKUP_NOTICE, MODEL_NOTICE]
  });
}
function named(root, file, limit) {
  if (file === undefined)
    return;
  const path = resolve3(root, file);
  try {
    const stat = statSync2(path);
    if (stat.isFile() && stat.size <= limit)
      return new Uint8Array(readFileSync3(path));
  } catch {}
  throw new InvalidInput(`${file} cannot be read, is not a regular file, or is over the size limit.`);
}
function sourceText(options, capture) {
  if (!capture)
    throw usage("source text needs a capture ID.");
  const actor = actorOf(options);
  if (!actor)
    throw usage("source text records who attached the text: give --actor.");
  const { method, tool } = options;
  if (method !== undefined && !["text_layer", "ocr", "manual"].includes(method))
    throw usage("--method is text_layer, ocr or manual.");
  if (tool === undefined !== (options["tool-version"] === undefined))
    throw usage("Give --tool and --tool-version together.");
  const root = requireProject(options);
  const corpus = openCorpus(root);
  const held = corpus.byId.get(capture)?.data;
  if (held?.kind !== "capture" || typeof held.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(held.sha256)) {
    throw new InvalidInput(`No usable capture record has the ID ${capture}.`);
  }
  const { store, path } = openStore(root, corpus, options);
  const copy = store.get(held.sha256);
  if (!copy) {
    throw new CommandError(5, "copy_not_held", `The stored copy ${held.sha256} is missing from ${path} or does not match its digest, so no text can be tied to it. Restore it, or add the same file again.`, [path]);
  }
  const layer = named(root, options["text-layer"], LIMITS.text_bytes);
  const pageMap = named(root, options["page-map"], LIMITS.page_map_bytes);
  const plan = planSourceText(corpus, {
    capture,
    copy,
    ...layer ? { layer } : {},
    ...pageMap ? { pageMap } : {},
    ...method ? { method } : {},
    ...tool ? { tool: { name: tool, version: options["tool-version"] } } : {},
    ...options.note ? { note: options.note } : {},
    stemma: VERSION,
    actor,
    now: new Date,
    token: randomToken
  });
  if (readProject(root).records.some((f) => f.path === plan.record.path))
    throw new InvalidInput(`${plan.record.path} already exists.`);
  store.put({ bytes: plan.text }, plan.text_sha256);
  writeProjectFile(root, plan.record.path, plan.record.text);
  const pages = plan.pages === 0 ? ["  pages: none (plain text without page breaks)"] : [
    `  pages: ${plan.pages}, split at the form feeds in the text`,
    `  without a printed label (file page indexes, from 0): ${plan.unmapped.length === 0 ? "none" : ranges(plan.unmapped)}. No label is worked out from a page's position.`
  ];
  const supplied = plan.method === "born_text" ? [] : [
    "Stemma did not make this text and did not compare it with the copy, page by page or at all: that it is the copy's text, with the pages in step, rests on what you supplied."
  ];
  const head = [
    `Saved the text as ${plan.record.id}.`,
    `  method: ${plan.method}, quality unassessed`,
    `  sha256: ${plan.text_sha256} (${plan.text.length} bytes)`,
    ...pages,
    `  wrote ${plan.record.path}`,
    ...supplied
  ].join(`
`);
  return reportRecords(options, validateFiles(openCorpus(root), new Set([plan.record.path])), `${head}
`, {
    extraction: plan.record.id,
    text_sha256: plan.text_sha256,
    pages: plan.pages,
    unmapped: plan.unmapped,
    method: plan.method
  });
}
function storeVerify(options) {
  const root = requireProject(options);
  const corpus = openCorpus(root);
  const { store, path, chosen_by } = openStore(root, corpus, options);
  const found = verifyStore(corpus, store, options.unreferenced ? store.list() : undefined);
  const bad = found.problems.length > 0 || found.unread_records.length > 0;
  const lines = [
    `Content store: ${path} (chosen by ${chosen_by}${existsSync3(path) ? "" : "; this directory does not exist"})`,
    `${found.referenced} blob(s) named by records: ${found.intact} present and matching, ${found.problems.length} not.`,
    ...found.problems.map((p) => `  ${p.state.toUpperCase()} ${p.sha256}
${p.named_by.map((f) => `      named by ${f}`).join(`
`)}`),
    ...found.problems.length > 0 ? [
      "Why it matters: checks that need these files report that they could not check.",
      "What to do: restore them from your backup of the store, or add the same files again."
    ] : [],
    ...found.unread_records.length > 0 ? [
      "These record files cannot be read, so what they name is unknown and the lists may be incomplete:",
      ...found.unread_records.map((p) => `  ${p}`)
    ] : [],
    ...found.unreferenced ? [
      `${found.unreferenced.length} blob(s) in the store that no record of this project names:`,
      ...found.unreferenced.map((d) => `  ${d}`),
      "Stemma deletes no blob. A store shared with another project holds blobs that project names."
    ] : [],
    BACKUP_NOTICE
  ];
  emit(options, { store: path, chosen_by, ...found }, `${lines.join(`
`)}
`);
  return bad ? 1 : 0;
}
function storeStatus(root, options) {
  const corpus = loadCorpus(readProject(root));
  if (!corpus.settings.data)
    return { note: "stemma.json cannot be read, so the content store is unknown." };
  let location;
  try {
    location = storeLocation(root, corpus.settings.data.project_id, options["store-dir"]);
  } catch (error) {
    return { note: error instanceof Error ? error.message : "The content store location is unknown." };
  }
  const refused = storeProblem(root, location.path);
  const named = [...referencedBlobs(corpus).keys()];
  const store = new BlobStore(location.path);
  return {
    ...location,
    exists: existsSync3(location.path),
    ...refused ? { refused } : {},
    blobs_named: named.length,
    blobs_present: refused ? 0 : named.filter((d) => store.has(d)).length,
    unread_records: unreadRecords(corpus).length
  };
}
function recordAdd(options, kind) {
  if (!kind || !Object.hasOwn(KINDS, kind))
    throw usage(`record add needs a record kind: ${Object.keys(KINDS).join(", ")}.`);
  if (!options.input)
    throw usage("record add needs --input <file> or --input - for standard input.");
  const root = requireProject(options);
  openCorpus(root);
  let input;
  try {
    input = readFileSync3(options.input === "-" ? 0 : resolve3(root, options.input), "utf8");
  } catch {
    throw new InvalidInput("The input file cannot be read.");
  }
  const actor = actorOf(options);
  const { id, path, text } = prepareRecord({ kind, input, ...actor ? { actor } : {}, now: new Date, token: randomToken });
  if (readProject(root).records.some((f) => f.path === path))
    throw new InvalidInput(`${path} already exists; record add does not overwrite.`);
  writeProjectFile(root, path, text);
  return reportRecords(options, validateFiles(openCorpus(root), new Set([path])), `Added ${id}
  ${path}
`, { added: { id, path } });
}
function targets(root, corpus, named) {
  const all = [corpus.settings, ...corpus.records].map((f) => f.path).concat(corpus.rules ? [corpus.rules.path] : []);
  if (named.length === 0)
    return new Set(all);
  return new Set(named.flatMap((name) => {
    const rel = projectRelative(root, name);
    const found = all.filter((p) => rel === "" || p === rel || p.startsWith(`${rel}/`));
    if (found.length === 0)
      throw new CommandError(5, "unknown_path", `No project record file is at ${name}.`, [name]);
    return found;
  }));
}
function validate2(options, named) {
  const root = requireProject(options);
  const corpus = openCorpus(root);
  return reportRecords(options, validateFiles(corpus, targets(root, corpus, named)), "", {});
}
function fmt(options, named) {
  const root = requireProject(options);
  const corpus = openCorpus(root);
  const wanted = targets(root, corpus, named);
  const plan = formatPlan(corpus, wanted);
  for (const { path, text } of plan)
    writeProjectFile(root, path, text);
  const changed = plan.map((f) => f.path);
  const head = `Rewrote ${changed.length} file(s) in canonical form.
${changed.map((p) => `  ${p}
`).join("")}`;
  return reportRecords(options, validateFiles(openCorpus(root), wanted), head, { changed });
}
function rulesCheck(options) {
  const root = requireProject(options);
  return reportRecords(options, validateFiles(openCorpus(root), new Set(["rules.md"])), "", {});
}
function check(options) {
  if (options.changed && options.all)
    throw usage("Use --changed or --all, not both.");
  const started = new Date;
  const root = requireProject(options);
  const corpus = openCorpus(root);
  const opened = referencedBlobs(corpus).size > 0 ? openStore(root, corpus, options) : undefined;
  const blobs = opened?.store ?? NO_STORE;
  const { body, errors } = runChecks(corpus, tools(), blobs);
  const report = {
    schema: "stemma.check-report/0",
    body,
    run: { started: started.toISOString(), duration_ms: Date.now() - started.getTime(), platform: `${process.platform}-${process.arch}` }
  };
  try {
    writeProjectFile(root, REPORT_PATH, canonical(report));
  } catch {
    throw new CommandError(70, "report_not_written", "The report could not be written, so this run does not count.", [REPORT_PATH]);
  }
  const widened = options.all ? "" : `The whole project is checked each time.
`;
  const absent = opened && body.results.some((r) => r.check === "source.held" && /_(missing|altered)$/.test(r.reason_code ?? "")) ? `Content store looked in: ${opened.path} (chosen by ${opened.chosen_by}). It is private and not part of the repository; where its files are absent or changed, nothing about them was checked.
` : "";
  emit(options, report, `${renderReport(body)}
${absent}${widened}Full report: ${join3(root, REPORT_PATH)}
`);
  if (errors.length > 0) {
    process.stderr.write(`A check failed to run. This is a Stemma defect and no result may be read as a pass.
${errors.join(`
`)}
`);
    return 70;
  }
  return body.label === "checked_clean" ? 0 : 1;
}
function dispatch(positionals, options) {
  const [command, ...rest] = positionals;
  const only = (count) => {
    if (rest.length > count)
      throw usage(`Too many arguments for ${command}.`);
  };
  switch (command) {
    case "version":
      only(0);
      return version(options);
    case "doctor":
      only(0);
      return doctor(options);
    case "init":
      only(0);
      return init(options);
    case "validate":
      return validate2(options, rest);
    case "fmt":
      return fmt(options, rest);
    case "check":
      only(0);
      return check(options);
    case "source":
      if (rest[0] === "add") {
        only(2);
        return sourceAdd(options, rest[1]);
      }
      if (rest[0] === "text") {
        only(2);
        return sourceText(options, rest[1]);
      }
      if (["admit", "reject", "confirm"].includes(rest[0] ?? "")) {
        throw new CommandError(2, "not_implemented", `\`source ${rest[0]}\` is not implemented in this version. Nothing was done.`);
      }
      throw usage("The source commands available now are `source add` and `source text`.");
    case "store":
      if (rest[0] !== "verify")
        throw usage("The only store command is `store verify`.");
      only(1);
      return storeVerify(options);
    case "record":
      if (["show", "search", "trace"].includes(rest[0] ?? "")) {
        throw new CommandError(2, "not_implemented", `\`record ${rest[0]}\` is not implemented in this version. Nothing was done.`);
      }
      if (rest[0] !== "add")
        throw usage("The record command available now is `record add`.");
      only(2);
      return recordAdd(options, rest[1]);
    case "rules":
      if (rest[0] !== "check")
        throw usage("The only rules command is `rules check`.");
      only(1);
      return rulesCheck(options);
    default:
      if (command && NOT_YET.has(command)) {
        throw new CommandError(2, "not_implemented", `\`${command}\` is not implemented in this version. Nothing was done.`);
      }
      throw usage(command ? `Unknown command: ${command}` : "No command given.");
  }
}
function main(argv) {
  let json = argv.includes("--format=json") || argv[argv.indexOf("--format") + 1] === "json";
  try {
    const wrong = runtimeProblem(Bun.version, process.execArgv);
    if (wrong)
      throw new CommandError(4, "wrong_runtime", wrong);
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          project: { type: "string" },
          format: { type: "string" },
          input: { type: "string" },
          actor: { type: "string" },
          changed: { type: "boolean" },
          all: { type: "boolean" },
          help: { type: "boolean" },
          "store-dir": { type: "string" },
          source: { type: "string" },
          origin: { type: "string" },
          "acquired-at": { type: "string" },
          "source-version": { type: "string" },
          unpublished: { type: "string" },
          "community-restricted": { type: "string" },
          license: { type: "string" },
          "text-layer": { type: "string" },
          "page-map": { type: "string" },
          method: { type: "string" },
          tool: { type: "string" },
          "tool-version": { type: "string" },
          note: { type: "string" },
          unreferenced: { type: "boolean" }
        }
      });
    } catch (error) {
      throw usage(error instanceof Error ? error.message : "Bad arguments.");
    }
    const { format = "text", help, ...rest } = parsed.values;
    if (format !== "text" && format !== "json")
      throw usage("--format is text or json.");
    json = format === "json";
    if (help) {
      process.stdout.write(USAGE);
      return 0;
    }
    const [first = "", second = ""] = parsed.positionals;
    const taken = COMMAND_OPTIONS[`${first} ${second}`] ?? COMMAND_OPTIONS[first];
    const extra = taken && Object.keys(rest).find((name) => !["project", "store-dir", ...taken].includes(name));
    if (extra)
      throw usage(`--${extra} is not an option of this command.`);
    return dispatch(parsed.positionals, { ...rest, format });
  } catch (error) {
    const known = error instanceof CommandError ? error : error instanceof InvalidInput ? new CommandError(5, "invalid_input", `${error.message} Nothing was written.`) : error instanceof UnsupportedFile ? new CommandError(5, "unsupported_file", error.message) : error instanceof UnsafeStore ? new CommandError(5, "unsafe_store", error.message) : error instanceof DuplicateCopy ? new CommandError(5, "already_held", `These exact bytes are already held: ${error.holders.map((h) => `source ${h.source} (capture ${h.capture})`).join(", ")}. Nothing was written and nothing was merged. To restore a missing blob, add the file with --source naming that source; to attach the same file to another source, name that one with --source.`, error.holders.map((h) => h.source)) : error instanceof NoExtractor ? new CommandError(2, "not_implemented", "This version cannot read text out of a PDF; no extraction library has been chosen. Supply the copy's text layer with --text-layer <file>, with a form feed after each page. Nothing was saved.") : error instanceof ActorNeeded ? usage("The input has no `created` stamp, so say who is adding it with --actor.") : error instanceof UnsafePath ? new CommandError(5, "unsafe_path", "That path leaves the project or is not a plain file. Nothing was written there.", [error.message]) : error instanceof AlreadyInitialized ? new CommandError(5, "already_initialized", "This directory already holds stemma.json; init changed nothing.") : new CommandError(70, "internal_error", `Internal error; no result may be read as a pass. ${error instanceof Error ? error.message : ""}`);
    if (json)
      process.stdout.write(canonical({ error: { code: known.code, message: known.message, paths: known.paths } }));
    else
      process.stderr.write(`${known.message}
`);
    return known.exit;
  }
}
if (import.meta.main)
  process.exitCode = main(process.argv.slice(2));
export {
  main
};
