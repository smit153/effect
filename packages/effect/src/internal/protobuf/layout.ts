// The layout of a schema on the wire: its messages, their fields and oneofs,
// and how each property is present. `compile.ts` builds it from a schema, and
// the codec interprets it without reading the schema.

import * as Option from "../../Option.ts"
import * as S from "./schema.ts"
import * as Wire from "./wire.ts"

// -----------------------------------------------------------------------------
// types
// -----------------------------------------------------------------------------

/**
 * How a single value is written, without its tag.
 *
 * @internal
 */
export type Type = Scalar | Enum | SymbolType | NullType | MessageType | Converted | Constant

/** @internal */
export interface Scalar {
  readonly _tag: "Scalar"
  readonly scalar: S.ScalarName
  readonly wireType: number
  // A 64-bit integer held in a JavaScript `number`.
  readonly asNumber: boolean
}

/** @internal */
export interface Enum {
  readonly _tag: "Enum"
  readonly wireType: typeof Wire.WIRE_VARINT
  // `undefined` when the values are their own enum numbers.
  readonly toNumber: ReadonlyMap<unknown, number> | undefined
  readonly fromNumber: ReadonlyMap<number, unknown> | undefined
}

// A registered symbol, written as its `Symbol.keyFor` key.
/** @internal */
export interface SymbolType {
  readonly _tag: "Symbol"
  readonly wireType: typeof Wire.WIRE_LEN
}

// `google.protobuf.NullValue`: `null`, written as 0. Any number reads as `null`.
/** @internal */
export interface NullType {
  readonly _tag: "Null"
  readonly wireType: typeof Wire.WIRE_VARINT
}

/** @internal */
export interface MessageType {
  readonly _tag: "Message"
  readonly wireType: typeof Wire.WIRE_LEN
  readonly message: Message
}

/**
 * A value written as a message of another shape, such as a `DateTime.Utc`
 * written as the seconds and nanos of a `google.protobuf.Timestamp`.
 *
 * @internal
 */
export interface Converted {
  readonly _tag: "Converted"
  readonly wireType: typeof Wire.WIRE_LEN
  readonly message: Message
  // Throws a `WireError` for a value without a representation.
  readonly toMessage: (value: unknown) => unknown
  // Why decoded fields are not a value, such as "timestamp out of range".
  readonly invalid: (fields: any) => string | undefined
  readonly fromMessage: (fields: any) => unknown
}

// An empty message standing for a value: a literal oneof case, or a nullish
// root.
/** @internal */
export interface Constant {
  readonly _tag: "Constant"
  readonly wireType: typeof Wire.WIRE_LEN
  readonly value: unknown
}

/**
 * What a property holds when its field is absent:
 *
 * - `"zero"`: implicit presence, the zero value
 * - `"omit"`: the key is left out
 * - `"null"` / `"undefined"`: that value
 * - `"none"`: `Option.none()`, and present values are `Option.some`
 * - `"required"`: left out, for the schema to report
 * - `"constant"`: the field's constant
 *
 * @internal
 */
export type Absent = "zero" | "omit" | "null" | "undefined" | "none" | "required" | "constant"

/**
 * How a property is present: `absent` is what an absent field decodes to, and
 * when `nullable` is set, `null` is absent when encoding, also inside an
 * `Option`. Elsewhere `null` is a value, such as a `google.protobuf.Value`.
 *
 * @internal
 */
export interface Presence {
  readonly absent: Absent
  readonly nullable: boolean
}

interface SlotBase extends Presence {
  readonly key: PropertyKey
  // The key is a member of `Object.prototype`, so it is only read when own, and
  // `__proto__` is defined rather than assigned.
  readonly guarded: boolean
}

/** @internal */
export interface Singular extends SlotBase {
  readonly _tag: "Singular"
  readonly number: number
  readonly type: Type
  // Writes the zero value of an implicit-presence field.
  readonly always: boolean
  readonly delimited: boolean
  // The value of a numbered literal.
  readonly constant: unknown
}

/** @internal */
export interface Repeated extends SlotBase {
  readonly _tag: "Repeated"
  readonly number: number
  readonly element: Type
  readonly packed: boolean
  readonly delimited: boolean
}

/** @internal */
export interface MapField extends SlotBase {
  readonly _tag: "Map"
  readonly number: number
  readonly keyType: Scalar
  readonly value: Type
  // Entries whose value is `undefined` are left out.
  readonly optionalValues: boolean
}

/** @internal */
export interface Oneof extends SlotBase {
  readonly _tag: "Oneof"
  readonly cases: ReadonlyArray<Case>
  // Whether values are `CaseValue`s, which name their case.
  readonly tagged: boolean
  // The case of a present value.
  readonly select: (value: unknown) => Case | undefined
  // The error for a value that is no case.
  readonly mismatch: string
}

/** @internal */
export interface Case {
  readonly _tag: "Case"
  readonly oneof: Oneof
  readonly number: number
  readonly type: Type
  readonly delimited: boolean
  // Set when the member is a tagged struct: the case value is the property at
  // `key`, and the literals are restored on decode.
  readonly unwrap: S.StructCase | undefined
}

/**
 * The entries of an index signature, spread into a struct as a map field.
 *
 * @internal
 */
export interface Rest {
  readonly _tag: "Rest"
  readonly number: number
  readonly keyType: Scalar
  readonly value: Type
  readonly optionalValues: boolean
  // The keys of an object that the index signature selects.
  readonly keysOf: (obj: Record<PropertyKey, unknown>) => ReadonlyArray<PropertyKey>
  // Keys of declared properties and of earlier index signatures are not this
  // field's, and are never written to it.
  readonly owns: (key: string) => boolean
}

/**
 * A property of a message.
 *
 * @internal
 */
export type Slot = Singular | Repeated | MapField | Oneof

/**
 * A numbered field of a message.
 *
 * @internal
 */
export type Field = Singular | Repeated | MapField | Case | Rest

/** @internal */
export interface Message {
  readonly name: string
  // - `struct`: an object with a slot per property
  // - `tuple`: an array, element `i` at field `i + 1`, the rest elements after
  // - `box`: a synthesized message whose one slot holds the value itself
  readonly shape: "struct" | "tuple" | "box"
  // A message the schema does not declare, such as a box: its keys are not
  // part of issue paths.
  readonly synthetic: boolean
  readonly slots: Array<Slot>
  readonly oneofs: Array<Oneof>
  readonly rest: Array<Rest>
  // The number of elements of a tuple, before its rest elements.
  readonly elements: number
  // Unnumbered literals, restored on decode.
  readonly constants: Array<readonly [PropertyKey, unknown]>
  readonly declared: Set<PropertyKey>
  unknown: { readonly key: PropertyKey; readonly optional: boolean } | undefined
  // In field-number order, the order fields are written in.
  readonly fields: Array<Field>
  readonly byNumber: Map<number, Field>
}

// The slot keys of synthesized messages, never part of an issue path.
/** @internal */
export const BOX_VALUE = Symbol("Protobuf/box")
/** @internal */
export const TUPLE_REST = Symbol("Protobuf/rest")

/**
 * What `toCodec` writes: the fields of a message, or of a converted or
 * constant value at the root.
 *
 * @internal
 */
export type Root = MessageType | Converted | Constant

// -----------------------------------------------------------------------------
// values
// -----------------------------------------------------------------------------

/** @internal */
export function scalar(scalar: S.ScalarName, asNumber = false): Scalar {
  return { _tag: "Scalar", scalar, wireType: scalarWireType(scalar), asNumber }
}

function scalarWireType(scalar: S.ScalarName): number {
  switch (scalar) {
    case "double":
    case "fixed64":
    case "sfixed64":
      return Wire.WIRE_I64
    case "float":
    case "fixed32":
    case "sfixed32":
      return Wire.WIRE_I32
    case "string":
    case "bytes":
      return Wire.WIRE_LEN
    default:
      return Wire.WIRE_VARINT
  }
}

/** @internal */
export function isPackable(type: Type): boolean {
  return type._tag === "Enum" || (type._tag === "Scalar" && type.wireType !== Wire.WIRE_LEN)
}

/**
 * The zero value of a type that is not a message.
 *
 * @internal
 */
export function zeroOf(type: Scalar | Enum | SymbolType | NullType | Constant): unknown {
  switch (type._tag) {
    case "Scalar":
      switch (type.scalar) {
        case "bool":
          return false
        case "string":
          return ""
        case "bytes":
          return Wire.EMPTY_BYTES
        default:
          return S.is64Bit(type.scalar) && !type.asNumber ? Wire.BIGINT_ZERO : 0
      }
    case "Enum":
      return enumValue(type, 0)
    case "Symbol":
      return Symbol.for("")
    case "Null":
      return null
    case "Constant":
      return type.value
  }
}

// Unknown numbers pass through, for the schema to judge.
/** @internal */
export function enumValue(type: Enum, n: number): unknown {
  if (type.fromNumber === undefined) return n
  const value = type.fromNumber.get(n)
  return value === undefined ? n : value
}

/**
 * The absent value of a slot that is not a message, or `undefined` when the
 * key is left out. Collections are new.
 *
 * @internal
 */
export function absentValue(slot: Slot): unknown {
  switch (slot.absent) {
    case "zero":
      switch (slot._tag) {
        case "Repeated":
          return []
        case "Map":
          return {}
        case "Singular":
          return zeroOf(slot.type as Scalar | Enum)
        default:
          return undefined
      }
    case "null":
      return null
    case "none":
      return Option.none()
    case "constant":
      return (slot as Singular).constant
    default:
      return undefined
  }
}

/**
 * Creates an empty message. Its slots are added with `addSlot`, which rejects
 * duplicate field numbers, and `finishMessage` prepares it for the codec.
 *
 * @internal
 */
export function makeMessage(
  name: string,
  shape: Message["shape"],
  options?: { readonly elements?: number; readonly synthetic?: boolean }
): Message {
  return {
    name,
    shape,
    synthetic: options?.synthetic ?? shape === "box",
    slots: [],
    oneofs: [],
    rest: [],
    elements: options?.elements ?? 0,
    constants: [],
    declared: new Set(),
    unknown: undefined,
    fields: [],
    byNumber: new Map()
  }
}

/** @internal */
export function addSlot(message: Message, slot: Slot | Rest): void {
  if (slot._tag === "Rest") {
    message.rest.push(slot)
    addField(message, slot, "index signature")
  } else if (slot._tag === "Oneof") {
    message.slots.push(slot)
    message.oneofs.push(slot)
    for (const c of slot.cases) addField(message, c, describeKey(slot.key))
  } else {
    message.slots.push(slot)
    addField(message, slot, describeKey(slot.key))
  }
}

function addField(message: Message, field: Field, describe: string): void {
  if (message.byNumber.has(field.number)) {
    throw layoutError(`duplicate field number ${field.number} in ${message.name} (${describe})`)
  }
  message.byNumber.set(field.number, field)
  message.fields.push(field)
}

/** @internal */
export function finishMessage(message: Message): Message {
  message.fields.sort((a, b) => a.number - b.number)
  return message
}

/** @internal */
export function layoutError(message: string): Error {
  return new Error(`Protobuf layout: ${message}`)
}

/** @internal */
export function describeKey(key: PropertyKey): string {
  if (key === BOX_VALUE) return "value"
  if (key === TUPLE_REST) return "rest"
  return typeof key === "string" ? `"${key}"` : String(key)
}
