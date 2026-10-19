// The layouts of the well-known types, written with the same messages as any
// schema, so that they are merged, read as groups, and checked like them.

import * as DateTime from "../../DateTime.ts"
import * as Duration_ from "../../Duration.ts"
import type { Case, Converted, Message, MessageType, Oneof, Slot } from "./layout.ts"
import { addSlot, BOX_VALUE, finishMessage, makeMessage, scalar } from "./layout.ts"
import * as Wire from "./wire.ts"

function messageOf(name: string, shape: Message["shape"], slots: ReadonlyArray<Slot>): MessageType {
  const message = makeMessage(name, shape, { synthetic: true })
  for (const slot of slots) addSlot(message, slot)
  return { _tag: "Message", wireType: Wire.WIRE_LEN, message: finishMessage(message) }
}

// -----------------------------------------------------------------------------
// Timestamp and Duration
// -----------------------------------------------------------------------------

interface Time {
  seconds: bigint
  nanos: number
}

// `message { int64 seconds = 1; int32 nanos = 2; }`
const time = messageOf("google.protobuf.Timestamp", "struct", [
  {
    _tag: "Singular",
    key: "seconds",
    guarded: false,
    number: 1,
    type: scalar("int64"),
    absent: "zero",
    nullable: false,
    always: false,
    delimited: false,
    constant: undefined
  },
  {
    _tag: "Singular",
    key: "nanos",
    guarded: false,
    number: 2,
    type: scalar("int32"),
    absent: "zero",
    nullable: false,
    always: false,
    delimited: false,
    constant: undefined
  }
]).message

// The range of `google.protobuf.Timestamp`, 0001-01-01T00:00:00Z through
// 9999-12-31T23:59:59.999999999Z.
const MIN_TIMESTAMP_SECONDS = -62_135_596_800
const MAX_TIMESTAMP_SECONDS = 253_402_300_799
// The range of `google.protobuf.Duration`, about 10,000 years.
const MAX_DURATION_SECONDS = BigInt(315_576_000_000)
const MAX_NANOS = 999_999_999
const NANOS_PER_SECOND = BigInt(1_000_000_000)
const NANOS_PER_MILLI = BigInt(1_000_000)
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

function fromMillis(millis: number, input: unknown): Time {
  if (!Number.isFinite(millis)) throw new Wire.WireError("expected a valid timestamp", input)
  const seconds = Math.floor(millis / 1000)
  if (seconds < MIN_TIMESTAMP_SECONDS || seconds > MAX_TIMESTAMP_SECONDS) {
    throw new Wire.WireError("timestamp out of range", input)
  }
  return { seconds: BigInt(seconds), nanos: (millis - seconds * 1000) * 1_000_000 }
}

function invalidTimestamp({ nanos, seconds }: Time): string | undefined {
  return seconds >= MIN_TIMESTAMP_SECONDS && seconds <= MAX_TIMESTAMP_SECONDS && nanos >= 0 && nanos <= MAX_NANOS
    ? undefined
    : "timestamp out of range"
}

// `DateTime.Utc` and `Date` have millisecond precision.
function toMillis({ nanos, seconds }: Time): number {
  return Number(seconds) * 1000 + Math.floor(nanos / 1_000_000)
}

/**
 * `google.protobuf.Timestamp` as a `DateTime.Utc`.
 *
 * @internal
 */
export const Timestamp: Converted = {
  _tag: "Converted",
  wireType: Wire.WIRE_LEN,
  message: time,
  toMessage: (value) => fromMillis(DateTime.isDateTime(value) ? DateTime.toEpochMillis(value) : NaN, value),
  invalid: invalidTimestamp,
  fromMessage: (fields) => DateTime.makeUnsafe(toMillis(fields))
}

/**
 * `google.protobuf.Timestamp` as a `Date`.
 *
 * @internal
 */
export const Date: Converted = {
  _tag: "Converted",
  wireType: Wire.WIRE_LEN,
  message: time,
  toMessage: (value) => fromMillis(value instanceof globalThis.Date ? value.getTime() : NaN, value),
  invalid: invalidTimestamp,
  fromMessage: (fields) => new globalThis.Date(toMillis(fields))
}

/**
 * `google.protobuf.Duration` as a `Duration`.
 *
 * @internal
 */
export const Duration: Converted = {
  _tag: "Converted",
  wireType: Wire.WIRE_LEN,
  message: time,
  toMessage: (value): Time => {
    if (!Duration_.isDuration(value) || !Duration_.isFinite(value)) {
      throw new Wire.WireError("expected a finite duration", value)
    }
    const total = Duration_.toNanosUnsafe(value)
    const seconds = total / NANOS_PER_SECOND
    if (seconds > MAX_DURATION_SECONDS || seconds < -MAX_DURATION_SECONDS) {
      throw new Wire.WireError("duration out of range", value)
    }
    return { seconds, nanos: Number(total - seconds * NANOS_PER_SECOND) }
  },
  invalid: ({ nanos, seconds }: Time) =>
    seconds <= MAX_DURATION_SECONDS && seconds >= -MAX_DURATION_SECONDS && nanos <= MAX_NANOS &&
      nanos >= -MAX_NANOS && (seconds === Wire.BIGINT_ZERO || nanos === 0 || (seconds < 0) === (nanos < 0))
      ? undefined
      : "duration out of range",
  fromMessage: ({ nanos, seconds }: Time) => {
    const total = seconds * NANOS_PER_SECOND + BigInt(nanos)
    // The millisecond representation when it is exact.
    return total % NANOS_PER_MILLI === Wire.BIGINT_ZERO && total <= MAX_SAFE && total >= -MAX_SAFE
      ? Duration_.millis(Number(total / NANOS_PER_MILLI))
      : Duration_.nanos(total)
  }
}

// -----------------------------------------------------------------------------
// Value, Struct, and ListValue
// -----------------------------------------------------------------------------

// A JSON value is the value of a oneof whose case is selected by its type, and
// a JSON object or array is the value of a map or repeated field. They are
// boxes, so that they are plain JSON when decoded.

const value = makeMessage("google.protobuf.Value", "box")

/**
 * `google.protobuf.Value` as a JSON value.
 *
 * @internal
 */
export const Value: MessageType = { _tag: "Message", wireType: Wire.WIRE_LEN, message: value }

/**
 * `google.protobuf.Struct` as a JSON object.
 *
 * @internal
 */
export const Struct: MessageType = messageOf("google.protobuf.Struct", "box", [{
  _tag: "Map",
  key: BOX_VALUE,
  guarded: false,
  number: 1,
  keyType: scalar("string"),
  value: Value,
  absent: "zero",
  nullable: false,
  optionalValues: false
}])

/**
 * `google.protobuf.ListValue` as a JSON array.
 *
 * @internal
 */
export const ListValue: MessageType = messageOf("google.protobuf.ListValue", "box", [{
  _tag: "Repeated",
  key: BOX_VALUE,
  guarded: false,
  number: 1,
  element: Value,
  absent: "zero",
  nullable: false,
  packed: false,
  delimited: false
}])

// A plain object: other objects, such as a `Date` or a class instance, are not
// JSON and would lose their data.
function isJsonObject(u: object): boolean {
  const proto = Object.getPrototypeOf(u)
  return proto === Object.prototype || proto === null
}

const kinds: Array<Case> = []
// A `Value` without a kind is `null`. The kind of a value is its JSON type.
const kind: Oneof = {
  _tag: "Oneof",
  key: BOX_VALUE,
  guarded: false,
  absent: "null",
  nullable: false,
  cases: kinds,
  tagged: false,
  select: (u) => {
    switch (typeof u) {
      case "number":
        return kinds[1]
      case "string":
        return kinds[2]
      case "boolean":
        return kinds[3]
      case "object":
        return u === null ? kinds[0] : Array.isArray(u) ? kinds[5] : isJsonObject(u) ? kinds[4] : undefined
      default:
        return undefined
    }
  },
  mismatch: "expected a JSON value"
}
const KINDS: ReadonlyArray<Case["type"]> = [
  { _tag: "Null", wireType: Wire.WIRE_VARINT },
  scalar("double"),
  scalar("string"),
  scalar("bool"),
  Struct,
  ListValue
]
KINDS.forEach((type, i) => {
  kinds.push({ _tag: "Case", oneof: kind, number: i + 1, type, delimited: false, unwrap: undefined })
})
addSlot(value, kind)
finishMessage(value)
