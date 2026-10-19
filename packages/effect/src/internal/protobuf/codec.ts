// Encodes and decodes the encoded side of a schema. `makeCodec` compiles its
// layout into a writer and a reader per field: closures that hold what they
// need, so that the hot paths read no layout. `Protobuf.toCodec` wraps the
// codec in a schema transformation.
//
// Decoding builds values in place: a later occurrence of a message field
// merges into the value of the earlier one. What can only be settled once all
// occurrences are read is kept on the `Input` of the decode, and settled at its
// end.

import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import * as InternalRecord from "../record.ts"
import * as L from "./layout.ts"
import { CaseValue, is64Bit, isUnsigned, type ScalarName } from "./schema.ts"
import * as Wire from "./wire.ts"

/** @internal */
export interface Codec {
  readonly encode: (value: unknown) => Uint8Array<ArrayBuffer>
  readonly decode: (bytes: Uint8Array) => unknown
}

/**
 * Both directions are synchronous, and throw a `WireError` for malformed input
 * or values without a wire representation.
 *
 * @internal
 */
export function makeCodec(root: L.Root): Codec {
  const compiled = new Map<L.Message, Compiled>()
  const write = fieldsWriter(compiled, root)
  const read = fieldsReader(compiled, root)
  return {
    encode: (value) => {
      const w = new Wire.Writer()
      write(w, value, 0)
      return w.finish()
    },
    decode: (bytes) => {
      const r = new Input(bytes)
      const value = read(r, undefined, bytes.length, undefined, 0)
      r.settle(value)
      return value
    }
  }
}

// Writes a value with its tag.
type ValueWriter = (w: Wire.Writer, value: unknown, depth: number) => void

// Writes a field of a message value. `depth` is that of the message, and
// `cases` holds the case of each of its oneofs.
type FieldWriter = (
  w: Wire.Writer,
  container: any,
  depth: number,
  cases: ReadonlyArray<L.Case | undefined>
) => void

// Reads one occurrence of a field, and returns the new value of its slot.
// `previous` is the value before, which a message merges into. Fields spread
// into the message value, the rest elements of a tuple and the entries of an
// index signature, are given that value and read into it.
type FieldReader = (r: Input, previous: unknown, wireType: number, number: number, depth: number) => unknown

// Write or read the fields of a message value, without its tag or length.
type FieldsWriter = (w: Wire.Writer, value: unknown, depth: number) => void
type FieldsReader = (r: Input, previous: unknown, end: number, group: number | undefined, depth: number) => unknown

/**
 * A message compiled for the codec. It is registered before its fields are
 * compiled, so that recursive messages refer to it.
 */
interface Compiled {
  readonly message: L.Message
  // In field-number order, with the key of each in issue paths.
  readonly writers: Array<FieldWriter>
  readonly writerKeys: Array<PropertyKey | undefined>
  // The case of each oneof. They fail for a value that is no case, before
  // anything is written.
  readonly selectors: Array<(container: any) => L.Case | undefined>
  // Readers by field number, and as an array unless the numbers are large.
  readonly readers: Map<number, Reader>
  table: ReadonlyArray<Reader | undefined> | undefined
  // A struct starts decoding as a copy of its template, which holds every
  // absent value that can be shared. `fresh` slots get a new collection when
  // they are still absent at the end.
  readonly template: Record<PropertyKey, unknown>
  readonly fresh: Array<L.Slot>
}

interface Reader {
  // Reads into the value of a box, which is the value of its slot. Fields
  // spread into a struct or tuple are never in a box.
  readonly read: FieldReader
  // Reads into the slot of a struct or tuple.
  readonly readInto: (r: Input, target: any, wireType: number, number: number, depth: number) => void
  // The key of the field in issue paths.
  readonly path: PropertyKey | undefined
}

function compile(compiled: Map<L.Message, Compiled>, message: L.Message): Compiled {
  const cached = compiled.get(message)
  if (cached !== undefined) return cached
  const out: Compiled = {
    message,
    writers: [],
    writerKeys: [],
    selectors: [],
    readers: new Map(),
    table: undefined,
    template: {},
    fresh: []
  }
  compiled.set(message, out)
  if (message.shape === "box" && message.oneofs.length === 1) {
    // The one slot of a box is written on its own.
    out.writers.push(oneofWriter(compiled, message, message.oneofs[0]))
    out.writerKeys.push(undefined)
  } else {
    for (const oneof of message.oneofs) out.selectors.push(caseSelector(message, oneof))
    for (const field of message.fields) {
      out.writers.push(fieldWriter(compiled, message, field))
      out.writerKeys.push(pathKey(message, field))
    }
  }
  for (const field of message.fields) out.readers.set(field.number, fieldReader(compiled, message, field))
  const max = message.fields.length === 0 ? 0 : message.fields[message.fields.length - 1].number
  if (max <= 1024) {
    const table: Array<Reader | undefined> = new Array(max + 1).fill(undefined)
    for (const [number, reader] of out.readers) table[number] = reader
    out.table = table
  }
  if (message.shape === "struct") {
    for (const slot of message.slots) {
      if (slot.absent === "omit" || slot.absent === "required") continue
      const fresh = slot.absent === "zero" && slot._tag !== "Singular"
      if (fresh) out.fresh.push(slot)
      InternalRecord.assignProperty(out.template, slot.key, fresh ? undefined : L.absentValue(slot))
    }
    for (const [key, value] of message.constants) InternalRecord.assignProperty(out.template, key, value)
    if (message.unknown !== undefined && !message.unknown.optional) {
      InternalRecord.assignProperty(out.template, message.unknown.key, Wire.EMPTY_BYTES)
    }
  }
  return out
}

// -----------------------------------------------------------------------------
// shared
// -----------------------------------------------------------------------------

// The value of an explicit-presence slot, or `undefined` when it is absent:
// `null` is absent when `nullable` is set, also inside an `Option` when
// `option` is.
function present(option: boolean, nullable: boolean, value: unknown): unknown {
  if (value === null && nullable) return undefined
  if (option && value !== undefined) {
    if (!Option.isOption(value)) throw new Wire.WireError("expected an Option", value)
    if (Option.isNone(value)) return undefined
    return value.value === null && nullable ? undefined : value.value
  }
  return value
}

// The value of a case, without its tag and the literals of its tagged struct.
function caseValue(c: L.Case): (value: unknown) => unknown {
  if (!c.oneof.tagged) return (value) => value
  const unwrap = c.unwrap
  if (unwrap === undefined) return (value) => (value as CaseValue).value
  return (value) => ownValue((value as CaseValue).value as Record<string, unknown>, unwrap.key)
}

// A `__proto__` key is read as an own property, as `InternalRecord.assignProperty`
// writes it: a plain read would return the prototype.
function ownValue(source: Record<PropertyKey, unknown>, key: PropertyKey): unknown {
  return key !== "__proto__" || Object.hasOwn(source, key) ? source[key] : undefined
}

// The key of a field in issue paths.
function pathKey(message: L.Message, field: L.Field): PropertyKey | undefined {
  if (message.synthetic) return undefined
  switch (field._tag) {
    case "Case":
      return field.oneof.key
    case "Rest":
      return undefined
    default:
      return field.key === L.TUPLE_REST ? undefined : field.key
  }
}

// Rethrows a wire error with `key` prepended to its path.
function rethrowAt(e: unknown, key: PropertyKey | undefined): never {
  if (e instanceof Wire.WireError && key !== undefined) e.path.unshift(key)
  throw e
}

function wrongWireType(actual: number, expected: number): never {
  throw new Wire.WireError(`wire type ${actual} does not match the field (expected ${expected})`)
}

// Message values merge with an earlier occurrence; other values replace it.
function merges(type: L.Type): boolean {
  return type._tag === "Message" || type._tag === "Converted"
}

// -----------------------------------------------------------------------------
// scalars
// -----------------------------------------------------------------------------

interface ScalarCodec {
  readonly read: (r: Wire.Reader) => unknown
  // Throws for a value outside the range of the scalar.
  readonly write: (w: Wire.Writer, value: unknown) => void
  // Whether an implicit-presence value is the zero value, which is not
  // written.
  readonly isZero: (value: unknown) => boolean
}

function expected(scalar: ScalarName, value: unknown): never {
  throw new Wire.WireError(`expected a protobuf ${scalar}`, value)
}

const isNumberZero = (value: unknown) => value === 0
// -0 is written, as other implementations do.
const isFloatZero = (value: unknown) => value === 0 && 1 / value > 0
const isBigIntZero = (value: unknown) => value === Wire.BIGINT_ZERO
const isInt64Zero = (value: unknown) => value === 0 || value === Wire.BIGINT_ZERO

function int32(scalar: ScalarName, value: unknown): number {
  return typeof value === "number" && Wire.isInt32(value) ? value : expected(scalar, value)
}

function uint32(scalar: ScalarName, value: unknown): number {
  return typeof value === "number" && Wire.isUint32(value) ? value : expected(scalar, value)
}

// A 64-bit integer: a bigint in the range of the scalar, or a safe integer when
// the scalar holds numbers.
function int64(scalar: ScalarName, asNumber: boolean, value: unknown): bigint | number {
  const unsigned = isUnsigned(scalar)
  if (typeof value === "bigint") {
    const inRange = unsigned
      ? value >= Wire.BIGINT_ZERO && value <= Wire.UINT64_MAX
      : value >= Wire.INT64_MIN && value <= Wire.INT64_MAX
    if (inRange) return value
  } else if (asNumber && typeof value === "number" && Number.isSafeInteger(value) && !(unsigned && value < 0)) {
    return value
  }
  return expected(scalar, value)
}

// Decodes the zigzag encoding of the last `varint64` in place.
function zigzag64(r: Wire.Reader): void {
  const mask = -(r.lo & 1)
  const lo = (((r.lo >>> 1) | (r.hi << 31)) ^ mask) >>> 0
  r.hi = ((r.hi >>> 1) ^ mask) >>> 0
  r.lo = lo
}

// The last 64-bit value read, as a number, which fails outside the safe
// integer range instead of losing precision.
function toNumber(scalar: ScalarName, r: Wire.Reader, signed: boolean): number {
  const { hi, lo } = r
  const n = (signed ? hi | 0 : hi) * 4294967296 + lo
  if (Number.isSafeInteger(n)) return n
  const exact = signed ? Wire.int64FromHalves(lo, hi) : Wire.uint64FromHalves(lo, hi)
  throw new Wire.WireError(`${scalar} value ${exact} is outside the safe integer range`)
}

const SCALARS: { readonly [K in ScalarName]: ScalarCodec } = {
  double: {
    read: (r) => r.double(),
    write: (w, v) => w.double(typeof v === "number" ? v : expected("double", v)),
    isZero: isFloatZero
  },
  float: {
    read: (r) => r.float(),
    write: (w, v) => {
      if (typeof v !== "number" || (Number.isFinite(v) && Math.abs(v) > Wire.FLOAT32_MAX)) expected("float", v)
      w.float(v)
    },
    isZero: isFloatZero
  },
  int32: { read: (r) => r.int32(), write: (w, v) => w.int32(int32("int32", v)), isZero: isNumberZero },
  uint32: { read: (r) => r.varint32(), write: (w, v) => w.uint32(uint32("uint32", v)), isZero: isNumberZero },
  sint32: {
    read: (r) => {
      const n = r.varint32()
      return (n >>> 1) ^ -(n & 1)
    },
    write: (w, v) => w.sint32(int32("sint32", v)),
    isZero: isNumberZero
  },
  fixed32: { read: (r) => r.fixed32(), write: (w, v) => w.fixed32(uint32("fixed32", v)), isZero: isNumberZero },
  sfixed32: { read: (r) => r.sfixed32(), write: (w, v) => w.sfixed32(int32("sfixed32", v)), isZero: isNumberZero },
  int64: {
    read: (r) => {
      r.varint64()
      return Wire.int64FromHalves(r.lo, r.hi)
    },
    write: (w, v) => w.int64(int64("int64", false, v)),
    isZero: isBigIntZero
  },
  uint64: {
    read: (r) => {
      r.varint64()
      return Wire.uint64FromHalves(r.lo, r.hi)
    },
    write: (w, v) => w.int64(int64("uint64", false, v)),
    isZero: isBigIntZero
  },
  sint64: {
    read: (r) => {
      r.varint64()
      zigzag64(r)
      return Wire.int64FromHalves(r.lo, r.hi)
    },
    write: (w, v) => w.sint64(int64("sint64", false, v)),
    isZero: isBigIntZero
  },
  fixed64: {
    read: (r) => {
      r.fixed64()
      return Wire.uint64FromHalves(r.lo, r.hi)
    },
    write: (w, v) => w.fixed64(int64("fixed64", false, v)),
    isZero: isBigIntZero
  },
  sfixed64: {
    read: (r) => {
      r.fixed64()
      return Wire.int64FromHalves(r.lo, r.hi)
    },
    write: (w, v) => w.fixed64(int64("sfixed64", false, v)),
    isZero: isBigIntZero
  },
  bool: {
    read: (r) => r.bool(),
    write: (w, v) => w.uint32(typeof v === "boolean" ? (v ? 1 : 0) : expected("bool", v)),
    isZero: (v) => v === false
  },
  string: {
    read: (r) => r.string(),
    write: (w, v) => w.string(typeof v === "string" ? v : expected("string", v)),
    isZero: (v) => v === ""
  },
  bytes: {
    read: (r) => r.bytes(),
    write: (w, v) => w.bytes(v instanceof Uint8Array ? v : expected("bytes", v)),
    isZero: (v) => v instanceof Uint8Array && v.length === 0
  }
}

// 64-bit integers held in numbers, like `[jstype = JS_NUMBER]`.
const NUMBER_SCALARS: { readonly [K in "int64" | "uint64" | "sint64" | "fixed64" | "sfixed64"]: ScalarCodec } = {
  int64: {
    read: (r) => {
      r.varint64()
      return toNumber("int64", r, true)
    },
    write: (w, v) => w.int64(int64("int64", true, v)),
    isZero: isInt64Zero
  },
  uint64: {
    read: (r) => {
      r.varint64()
      return toNumber("uint64", r, false)
    },
    write: (w, v) => w.int64(int64("uint64", true, v)),
    isZero: isInt64Zero
  },
  sint64: {
    read: (r) => {
      r.varint64()
      zigzag64(r)
      return toNumber("sint64", r, true)
    },
    write: (w, v) => w.sint64(int64("sint64", true, v)),
    isZero: isInt64Zero
  },
  fixed64: {
    read: (r) => {
      r.fixed64()
      return toNumber("fixed64", r, false)
    },
    write: (w, v) => w.fixed64(int64("fixed64", true, v)),
    isZero: isInt64Zero
  },
  sfixed64: {
    read: (r) => {
      r.fixed64()
      return toNumber("sfixed64", r, true)
    },
    write: (w, v) => w.fixed64(int64("sfixed64", true, v)),
    isZero: isInt64Zero
  }
}

function scalarCodec(type: L.Scalar): ScalarCodec {
  return type.asNumber ? NUMBER_SCALARS[type.scalar as keyof typeof NUMBER_SCALARS] : SCALARS[type.scalar]
}

function enumNumber(type: L.Enum, value: unknown): number {
  const n = type.toNumber === undefined ? value : type.toNumber.get(value)
  if (typeof n !== "number" || !Wire.isInt32(n)) throw new Wire.WireError("expected an enum value", value)
  return n
}

// The codec of a packable type: a scalar that is not length-delimited, or an
// enum.
function packableCodec(type: L.Scalar | L.Enum): ScalarCodec {
  if (type._tag === "Scalar") return scalarCodec(type)
  return {
    read: (r) => L.enumValue(type, r.int32()),
    write: (w, v) => w.int32(enumNumber(type, v)),
    isZero: (v) => enumNumber(type, v) === 0
  }
}

function isPackable(type: L.Type): type is L.Scalar | L.Enum {
  return type._tag === "Enum" || (type._tag === "Scalar" && type.wireType !== Wire.WIRE_LEN)
}

// -----------------------------------------------------------------------------
// encode
// -----------------------------------------------------------------------------

// The value of a slot in a message value.
function getter(message: L.Message, slot: L.Slot): (container: any) => unknown {
  const key = slot.key
  switch (message.shape) {
    case "struct":
      return slot.guarded ? (c) => Object.hasOwn(c, key) ? c[key] : undefined : (c) => c[key]
    case "tuple":
      return (c) => c[key]
    case "box":
      return (c) => c
  }
}

function fieldsWriter(
  compiled: Map<L.Message, Compiled>,
  type: L.MessageType | L.Converted | L.Constant
): FieldsWriter {
  switch (type._tag) {
    case "Message": {
      const message = compile(compiled, type.message)
      return (w, value, depth) => writeMessage(w, message, value, depth)
    }
    case "Converted": {
      const message = compile(compiled, type.message)
      const toMessage = type.toMessage
      return (w, value, depth) => writeMessage(w, message, toMessage(value), depth)
    }
    case "Constant":
      // An empty message, nested like any other.
      return (_, __, depth) => {
        if (depth > Wire.MAX_DEPTH) throw new Wire.WireError(`nesting deeper than ${Wire.MAX_DEPTH}`)
      }
  }
}

// `depth` is limited like it is when decoding, so that whatever is written can
// be read back.
function writeMessage(w: Wire.Writer, compiled: Compiled, value: any, depth: number): void {
  if (depth > Wire.MAX_DEPTH) throw new Wire.WireError(`nesting deeper than ${Wire.MAX_DEPTH}`)
  const message = compiled.message
  if (message.shape === "struct" && !Predicate.isObject(value)) {
    throw new Wire.WireError(`expected an object for ${message.name}`, value)
  }
  if (message.shape === "tuple" && !Array.isArray(value)) {
    throw new Wire.WireError(`expected an array for ${message.name}`, value)
  }
  let key: PropertyKey | undefined
  try {
    const selectors = compiled.selectors
    let cases: Array<L.Case | undefined> = NO_CASES
    if (selectors.length > 0) {
      cases = []
      for (let i = 0; i < selectors.length; i++) {
        key = message.synthetic ? undefined : message.oneofs[i].key
        cases.push(selectors[i](value))
      }
    }
    const writers = compiled.writers
    const keys = compiled.writerKeys
    for (let i = 0; i < writers.length; i++) {
      key = keys[i]
      writers[i](w, value, depth, cases)
    }
    if (message.unknown !== undefined) {
      key = message.unknown.key
      const bytes = ownValue(value, key)
      if (bytes !== undefined) writeUnknown(w, message, bytes, depth)
    }
  } catch (e) {
    rethrowAt(e, key)
  }
}

const NO_CASES: Array<L.Case | undefined> = []

function caseSelector(message: L.Message, oneof: L.Oneof): (container: any) => L.Case | undefined {
  const get = getter(message, oneof)
  const option = oneof.absent === "none"
  const nullable = oneof.nullable
  const { mismatch, select } = oneof
  return (container) => {
    const v = present(option, nullable, get(container))
    if (v === undefined) return undefined
    const c = select(v)
    if (c === undefined) throw new Wire.WireError(mismatch, v)
    return c
  }
}

// Writes a oneof on its own, rather than case by case in field-number order,
// as the one slot of a box is.
function oneofWriter(compiled: Map<L.Message, Compiled>, message: L.Message, oneof: L.Oneof): FieldWriter {
  const get = getter(message, oneof)
  const option = oneof.absent === "none"
  const nullable = oneof.nullable
  const { mismatch, select } = oneof
  const writers = new Map(oneof.cases.map((c) => {
    const write = valueWriter(compiled, c.type, c.number, c.delimited)
    const unwrap = caseValue(c)
    return [c, (w: Wire.Writer, value: unknown, depth: number) => write(w, unwrap(value), depth)] as const
  }))
  return (w, container, depth) => {
    const v = present(option, nullable, get(container))
    if (v === undefined) return
    const write = writers.get(select(v)!)
    if (write === undefined) throw new Wire.WireError(mismatch, v)
    write(w, v, depth)
  }
}

// Unknown fields must be well-formed, and must not hold declared fields, which
// would be read back into them.
function writeUnknown(w: Wire.Writer, message: L.Message, bytes: unknown, depth: number): void {
  if (!(bytes instanceof Uint8Array)) throw new Wire.WireError("expected the bytes of unknown fields", bytes)
  const r = new Wire.Reader(bytes)
  while (r.pos < bytes.length) {
    const tag = r.tag()
    if (message.byNumber.has(tag >>> 3)) throw new Wire.WireError(`unknown fields hold declared field ${tag >>> 3}`)
    r.skip(tag & 7, tag >>> 3, depth)
  }
  w.raw(bytes)
}

function fieldWriter(compiled: Map<L.Message, Compiled>, message: L.Message, field: L.Field): FieldWriter {
  switch (field._tag) {
    case "Singular":
      return singularWriter(compiled, message, field)
    case "Repeated": {
      const writeList = listWriter(compiled, field)
      if (field.key === L.TUPLE_REST) {
        const start = message.elements
        return (w, container, depth) => writeList(w, container, start, depth)
      }
      const get = getter(message, field)
      const option = field.absent === "none"
      const nullable = field.nullable
      return (w, container, depth) => {
        const v = present(option, nullable, get(container))
        if (v === undefined) return
        if (!Array.isArray(v)) throw new Wire.WireError("expected an array", v)
        writeList(w, v, 0, depth)
      }
    }
    case "Map": {
      const writeEntry = entryWriter(compiled, field)
      const get = getter(message, field)
      const option = field.absent === "none"
      const nullable = field.nullable
      return (w, container, depth) => {
        const v = present(option, nullable, get(container))
        if (v === undefined) return
        if (!Predicate.isObject(v)) throw new Wire.WireError("expected a record", v)
        for (const k of Object.keys(v)) writeEntry(w, k, v[k], depth)
      }
    }
    case "Rest": {
      const writeEntry = entryWriter(compiled, field)
      const keysOf = field.keysOf
      const owns = field.owns
      return (w, container, depth) => {
        for (const k of keysOf(container)) {
          if (typeof k === "string" && owns(k)) writeEntry(w, k, container[k], depth)
        }
      }
    }
    case "Case": {
      const oneof = field.oneof
      const index = message.oneofs.indexOf(oneof)
      const get = getter(message, oneof)
      const option = oneof.absent === "none"
      const nullable = oneof.nullable
      const unwrap = caseValue(field)
      const write = valueWriter(compiled, field.type, field.number, field.delimited)
      return (w, container, depth, cases) => {
        if (cases[index] === field) write(w, unwrap(present(option, nullable, get(container))), depth)
      }
    }
  }
}

function singularWriter(compiled: Map<L.Message, Compiled>, message: L.Message, field: L.Singular): FieldWriter {
  const skipZero = field.absent === "zero" && !field.always
  const write = valueWriter(compiled, field.type, field.number, field.delimited, skipZero)
  if (message.shape === "struct" && !field.guarded && field.absent !== "none" && !field.nullable) {
    const key = field.key
    return (w, container, depth) => {
      const v = container[key]
      if (v !== undefined) write(w, v, depth)
    }
  }
  const get = getter(message, field)
  const option = field.absent === "none"
  const nullable = field.nullable
  return (w, container, depth) => {
    const v = present(option, nullable, get(container))
    if (v !== undefined) write(w, v, depth)
  }
}

// Writes the elements of a list from `start`, reporting the index of a failing
// one.
function listWriter(
  compiled: Map<L.Message, Compiled>,
  field: L.Repeated
): (w: Wire.Writer, list: ReadonlyArray<unknown>, start: number, depth: number) => void {
  const element = field.element
  if (field.packed && isPackable(element)) {
    const tag = field.number * 8 + Wire.WIRE_LEN
    const write = packableCodec(element).write
    const size = element._tag === "Scalar" ? fixedSize(element) : 0
    const double = element._tag === "Scalar" && element.scalar === "double"
    return (w, list, start) => {
      if (list.length <= start) return
      let i = start
      try {
        w.uint32(tag)
        if (size > 0) {
          // The length of fixed-width elements is known up front.
          w.uint32((list.length - start) * size)
          w.ensure((list.length - start) * size)
          if (double) {
            for (; i < list.length; i++) {
              const v = list[i]
              if (typeof v !== "number") expected("double", v)
              w.view.setFloat64(w.pos, v, true)
              w.pos += 8
            }
          } else {
            for (; i < list.length; i++) write(w, list[i])
          }
        } else {
          const begin = w.begin()
          for (; i < list.length; i++) write(w, list[i])
          w.end(begin)
        }
      } catch (e) {
        rethrowAt(e, i)
      }
    }
  }
  const write = valueWriter(compiled, element, field.number, field.delimited)
  return (w, list, start, depth) => {
    let i = start
    try {
      for (; i < list.length; i++) write(w, list[i], depth)
    } catch (e) {
      rethrowAt(e, i)
    }
  }
}

function fixedSize(type: L.Scalar): number {
  switch (type.wireType) {
    case Wire.WIRE_I64:
      return 8
    case Wire.WIRE_I32:
      return 4
    default:
      return 0
  }
}

// Writes a map entry, reporting its key when it fails. Both the key and the
// value are written, even when they are zero.
function entryWriter(
  compiled: Map<L.Message, Compiled>,
  field: L.MapField | L.Rest
): (w: Wire.Writer, key: string, value: unknown, depth: number) => void {
  const tag = field.number * 8 + Wire.WIRE_LEN
  const keyType = field.keyType
  const keyTag = 8 + keyType.wireType
  const writeKey = scalarCodec(keyType).write
  const writeValue = valueWriter(compiled, field.value, 2, false)
  const optionalValues = field.optionalValues
  return (w, key, value, depth) => {
    if (value === undefined && optionalValues) return
    try {
      w.uint32(tag)
      const start = w.begin()
      w.uint32(keyTag)
      writeKey(w, mapKeyFromString(keyType, key))
      writeValue(w, value, depth)
      w.end(start)
    } catch (e) {
      rethrowAt(e, key)
    }
  }
}

const INTEGER_KEY = /^-?\d+$/

function mapKeyFromString(type: L.Scalar, key: string): unknown {
  switch (type.scalar) {
    case "string":
      return key
    case "bool":
      if (key === "true") return true
      if (key === "false") return false
      break
    case "double":
    case "float": {
      const n = Number(key)
      if (String(n) === key) return n
      break
    }
    default:
      if (!INTEGER_KEY.test(key)) break
      return is64Bit(type.scalar) && !type.asNumber ? BigInt(key) : Number(key)
  }
  throw new Wire.WireError(`expected a protobuf ${type.scalar} map key`, key)
}

// Writes a value with its tag. With `skipZero`, the zero value of an
// implicit-presence field is not written.
function valueWriter(
  compiled: Map<L.Message, Compiled>,
  type: L.Type,
  number: number,
  delimited: boolean,
  skipZero = false
): ValueWriter {
  switch (type._tag) {
    case "Scalar":
      return scalarWriter(type, number * 8 + type.wireType, skipZero)
    case "Enum": {
      const tag = number * 8 + Wire.WIRE_VARINT
      return (w, value) => {
        const n = enumNumber(type, value)
        if (skipZero && n === 0) return
        w.uint32(tag)
        w.int32(n)
      }
    }
    case "Symbol": {
      const tag = number * 8 + Wire.WIRE_LEN
      return (w, value) => {
        const key = typeof value === "symbol" ? Symbol.keyFor(value) : undefined
        if (key === undefined) throw new Wire.WireError("expected a registered symbol (Symbol.for)", value)
        w.uint32(tag)
        w.string(key)
      }
    }
    case "Null": {
      const tag = number * 8 + Wire.WIRE_VARINT
      return (w) => {
        w.uint32(tag)
        w.uint32(0)
      }
    }
    default: {
      const writeFields = fieldsWriter(compiled, type)
      if (delimited) {
        const start = number * 8 + Wire.WIRE_SGROUP
        const end = number * 8 + Wire.WIRE_EGROUP
        return (w, value, depth) => {
          w.uint32(start)
          writeFields(w, value, depth + 1)
          w.uint32(end)
        }
      }
      const tag = number * 8 + Wire.WIRE_LEN
      return (w, value, depth) => {
        w.uint32(tag)
        const start = w.begin()
        writeFields(w, value, depth + 1)
        w.end(start)
      }
    }
  }
}

// The common scalars have their own writers, which skip the indirection of the
// others.
function scalarWriter(type: L.Scalar, tag: number, skipZero: boolean): ValueWriter {
  switch (type.asNumber ? undefined : type.scalar) {
    case "string":
      return (w, value) => {
        if (typeof value !== "string") expected("string", value)
        if (skipZero && value === "") return
        w.uint32(tag)
        w.string(value)
      }
    case "bool":
      return (w, value) => {
        if (typeof value !== "boolean") expected("bool", value)
        if (skipZero && !value) return
        w.uint32(tag)
        w.uint32(value ? 1 : 0)
      }
    case "double":
      return (w, value) => {
        if (typeof value !== "number") expected("double", value)
        if (skipZero && isFloatZero(value)) return
        w.uint32(tag)
        w.double(value)
      }
    case "int32":
      return (w, value) => {
        if (skipZero && value === 0) return
        w.uint32(tag)
        w.int32(int32("int32", value))
      }
    case "uint32":
      return (w, value) => {
        if (skipZero && value === 0) return
        w.uint32(tag)
        w.uint32(uint32("uint32", value))
      }
    case "int64":
    case "uint64": {
      const scalar = type.scalar
      return (w, value) => {
        if (skipZero && value === Wire.BIGINT_ZERO) return
        w.uint32(tag)
        w.int64(int64(scalar, false, value))
      }
    }
  }
  const { isZero, write } = scalarCodec(type)
  return (w, value) => {
    if (skipZero && isZero(value)) return
    w.uint32(tag)
    write(w, value)
  }
}

// -----------------------------------------------------------------------------
// decode
// -----------------------------------------------------------------------------

/**
 * A `Converted` value whose fields are not a value, such as a Timestamp out of
 * range. A later occurrence can still merge into it, so it only fails the
 * decode if it is still there at the end.
 */
class Invalid {
  readonly reason: string
  readonly fields: unknown
  constructor(reason: string, fields: unknown) {
    this.reason = reason
    this.fields = fields
  }
}

// The input of one decode, and what is settled once all of it is read.
class Input extends Wire.Reader {
  // Tuples with an absent element, which ends them. They are truncated at the
  // end, since a later occurrence can still fill the element.
  tuples: Array<Array<unknown>> | undefined = undefined
  // The unknown fields of structs that occurred several times, joined at the
  // end, which keeps merging linear.
  unknown: Map<object, { readonly key: PropertyKey; readonly chunks: Array<Uint8Array> }> | undefined = undefined
  // The number of `Invalid` values read.
  invalid = 0

  settle(value: unknown): void {
    if (this.unknown !== undefined) {
      for (const [target, { chunks, key }] of this.unknown) InternalRecord.assignProperty(target, key, concat(chunks))
    }
    if (this.tuples !== undefined) {
      for (const tuple of this.tuples) {
        for (let i = 0; i < tuple.length; i++) {
          if (!(i in tuple)) {
            tuple.length = i
            break
          }
        }
      }
    }
    if (this.invalid > 0) rejectInvalid(value)
  }
}

// Reads the fields of a message value up to `end`, or up to the end group tag
// of field `group`.
function fieldsReader(
  compiled: Map<L.Message, Compiled>,
  type: L.MessageType | L.Converted | L.Constant
): FieldsReader {
  switch (type._tag) {
    case "Message": {
      const message = compile(compiled, type.message)
      return (r, previous, end, group, depth) => readMessage(r, message, previous, end, group, depth)
    }
    case "Converted": {
      const message = compile(compiled, type.message)
      const { fromMessage, invalid, toMessage } = type
      return (r, previous, end, group, depth) => {
        const before = previous === undefined
          ? undefined
          : previous instanceof Invalid
          ? previous.fields
          : toMessage(previous)
        const fields = readMessage(r, message, before, end, group, depth)
        const reason = invalid(fields)
        if (reason === undefined) return fromMessage(fields)
        r.invalid++
        return new Invalid(reason, fields)
      }
    }
    case "Constant": {
      const empty = compile(compiled, EMPTY)
      const value = type.value
      return (r, _, end, group, depth) => {
        readMessage(r, empty, undefined, end, group, depth)
        return value
      }
    }
  }
}

// A message without fields, for reading values that are empty messages.
const EMPTY = L.finishMessage(L.makeMessage("empty message", "box"))

// Reads a message value: a struct or tuple, built in place, or the value of a
// box.
function readMessage(
  r: Input,
  compiled: Compiled,
  previous: unknown,
  end: number,
  group: number | undefined,
  depth: number
): unknown {
  if (depth > Wire.MAX_DEPTH) throw new Wire.WireError(`nesting deeper than ${Wire.MAX_DEPTH}`)
  const message = compiled.message
  switch (message.shape) {
    case "struct": {
      const value: any = Predicate.isObject(previous) ? previous : { ...compiled.template }
      readInto(r, compiled, value, end, group, depth)
      const fresh = compiled.fresh
      for (let i = 0; i < fresh.length; i++) {
        if (value[fresh[i].key] === undefined) value[fresh[i].key] = L.absentValue(fresh[i])
      }
      return value
    }
    case "tuple": {
      const value: Array<unknown> = Array.isArray(previous) ? previous : new Array(message.elements)
      readInto(r, compiled, value, end, group, depth)
      for (const [i, constant] of message.constants) value[i as number] = constant
      for (const slot of message.slots) {
        if (slot.key === L.TUPLE_REST || slot.key in value) continue
        const absent = L.absentValue(slot)
        if (absent !== undefined) value[slot.key as number] = absent
      }
      for (let i = 0; i < message.elements; i++) {
        if (!(i in value)) {
          ;(r.tuples ??= []).push(value)
          break
        }
      }
      return value
    }
    case "box": {
      // The value of a box is that of its slot. Being synthetic, it adds no
      // key to issue paths, and keeps no unknown fields.
      const table = compiled.table
      let value = previous
      for (let tag = nextTag(r, end, group); tag !== 0; tag = nextTag(r, end, group)) {
        const reader = table !== undefined ? table[tag >>> 3] : compiled.readers.get(tag >>> 3)
        if (reader === undefined) r.skip(tag & 7, tag >>> 3, depth)
        else value = reader.read(r, value, tag & 7, tag >>> 3, depth)
      }
      if (group === undefined && r.pos !== end) throw new Wire.WireError("field overruns its message")
      return value === undefined && message.slots.length > 0 ? L.absentValue(message.slots[0]) : value
    }
  }
}

// Reads the fields of a struct or tuple into `target`.
function readInto(
  r: Input,
  compiled: Compiled,
  target: object,
  end: number,
  group: number | undefined,
  depth: number
): void {
  const table = compiled.table
  const keepUnknown = compiled.message.unknown !== undefined
  let unknown: Array<Uint8Array> | undefined
  let path: PropertyKey | undefined
  try {
    let start = r.pos
    for (let tag = nextTag(r, end, group); tag !== 0; start = r.pos, tag = nextTag(r, end, group)) {
      const number = tag >>> 3
      const reader = table !== undefined ? table[number] : compiled.readers.get(number)
      if (reader === undefined) {
        r.skip(tag & 7, number, depth)
        if (keepUnknown) (unknown ??= []).push(r.buf.subarray(start, r.pos))
      } else {
        path = reader.path
        reader.readInto(r, target, tag & 7, number, depth)
        path = undefined
      }
    }
    if (group === undefined && r.pos !== end) throw new Wire.WireError("field overruns its message")
  } catch (e) {
    rethrowAt(e, path)
  }
  if (unknown !== undefined) readUnknown(r, compiled.message.unknown!.key, target, unknown)
}

// Reads the next tag of a message that ends at `end`, or of a group of field
// `group`, or returns 0 at its end.
function nextTag(r: Input, end: number, group: number | undefined): number {
  const pos = r.pos
  if (pos >= end) {
    if (group !== undefined) throw new Wire.WireError("premature end of input")
    return 0
  }
  // Tags of fields 1 through 15 are a single byte.
  const byte = r.buf[pos]
  let tag: number
  if (byte < 0x80 && byte >= 8 && (byte & 7) <= Wire.WIRE_I32) {
    tag = byte
    r.pos = pos + 1
  } else {
    tag = r.tag()
  }
  if ((tag & 7) !== Wire.WIRE_EGROUP) return tag
  if (tag >>> 3 === group) return 0
  throw new Wire.WireError(`unexpected end group tag for field ${tag >>> 3}`)
}

// Keeps the unknown fields of a struct, joining them to those of an earlier
// occurrence at the end of the decode.
function readUnknown(r: Input, key: PropertyKey, target: object, chunks: Array<Uint8Array>): void {
  const before = Object.hasOwn(target, key) ? (target as any)[key] : undefined
  if (before instanceof Uint8Array && before.length > 0) {
    const merged = r.unknown ??= new Map()
    let entry = merged.get(target)
    if (entry === undefined) merged.set(target, entry = { key, chunks: [before] })
    for (let i = 0; i < chunks.length; i++) entry.chunks.push(chunks[i])
  } else {
    InternalRecord.assignProperty(target, key, concat(chunks))
  }
}

// Each slot has a reader that returns its new value, for boxes, and one that
// reads into a struct or tuple. They bind the slot to a plain function, which
// reads one occurrence given the value before.
function fieldReader(compiled: Map<L.Message, Compiled>, message: L.Message, field: L.Field): Reader {
  const path = pathKey(message, field)
  switch (field._tag) {
    case "Singular": {
      const type = field.type
      const read = valueReader(compiled, type)
      const option = field.absent === "none"
      const nullable = field.nullable
      if (!option && !(nullable && merges(type))) {
        const readInto = field.guarded
          ? guardedReader(field.key, read, merges(type))
          : (type._tag === "Scalar" ? scalarReaderInto(type, field.key) : undefined) ??
            plainReader(field.key, read, merges(type))
        return { read, readInto, path }
      }
      const value: FieldReader = (r, previous, wireType, number, depth) =>
        readSingular(r, previous, read, option, nullable, wireType, number, depth)
      const readInto = field.guarded
        ? guardedReader(field.key, value, merges(type))
        : plainReader(field.key, value, merges(type))
      return { read: value, readInto, path }
    }
    case "Repeated": {
      const read = valueReader(compiled, field.element)
      const readPacked = isPackable(field.element) ? packedReader(field.element) : undefined
      if (field.key === L.TUPLE_REST) {
        // The rest elements of a tuple are read into the tuple itself.
        const readInto = (r: Input, list: unknown, wireType: number, number: number, depth: number) =>
          readElements(r, list as Array<unknown>, read, readPacked, wireType, number, depth)
        return { read: readInto, readInto, path }
      }
      const key = field.key
      const option = field.absent === "none"
      const nullable = field.nullable
      const value: FieldReader = (r, previous, wireType, number, depth) =>
        readList(r, previous, read, readPacked, option, nullable, wireType, number, depth)
      if (field.guarded) return { read: value, readInto: guardedReader(key, value, true), path }
      return {
        read: value,
        readInto: (r, target, wireType, number, depth) => {
          target[key] = readList(r, target[key], read, readPacked, option, nullable, wireType, number, depth)
        },
        path
      }
    }
    case "Map": {
      const readEntry = entryReader(compiled, field)
      const key = field.key
      const option = field.absent === "none"
      const nullable = field.nullable
      const value: FieldReader = (r, previous, wireType, _, depth) =>
        readRecord(r, previous, readEntry, option, nullable, wireType, depth)
      if (field.guarded) return { read: value, readInto: guardedReader(key, value, true), path }
      return {
        read: value,
        readInto: (r, target, wireType, _, depth) => {
          target[key] = readRecord(r, target[key], readEntry, option, nullable, wireType, depth)
        },
        path
      }
    }
    case "Rest": {
      // The entries of an index signature are read into the struct itself.
      const readEntry = entryReader(compiled, field)
      const readInto = (r: Input, target: unknown, wireType: number, _: number, depth: number) =>
        readEntry(r, target, wireType, depth)
      return { read: readInto, readInto, path }
    }
    case "Case": {
      const info = caseInfo(compiled, field)
      const key = field.oneof.key
      // An untagged case that does not merge is just its value.
      const value: FieldReader = !info.tagged && info.member === undefined && !info.option && info.select === undefined
        ? info.read
        : (r, previous, wireType, _, depth) => readCase(r, previous, info, wireType, depth)
      if (field.oneof.guarded) {
        return { read: value, readInto: guardedReader(key, value, info.select !== undefined), path }
      }
      return {
        read: value,
        readInto: (r, target, wireType, _, depth) => {
          target[key] = readCase(r, target[key], info, wireType, depth)
        },
        path
      }
    }
  }
}

function plainReader(key: PropertyKey, read: FieldReader, loads: boolean): Reader["readInto"] {
  return loads
    ? (r, target, wireType, number, depth) => {
      target[key] = read(r, target[key], wireType, number, depth)
    }
    : (r, target, wireType, number, depth) => {
      target[key] = read(r, undefined, wireType, number, depth)
    }
}

// A key of `Object.prototype` is read only when own, and `__proto__` is
// defined rather than assigned.
function guardedReader(key: PropertyKey, read: FieldReader, loads: boolean): Reader["readInto"] {
  return (r, target, wireType, number, depth) => {
    const before = loads && Object.hasOwn(target, key) ? target[key] : undefined
    InternalRecord.assignProperty(target, key, read(r, before, wireType, number, depth))
  }
}

// Reads the common scalars into the slot at `key`. Each has its own reader,
// which skips the indirection of the others.
function scalarReaderInto(type: L.Scalar, key: PropertyKey): Reader["readInto"] | undefined {
  switch (type.asNumber ? undefined : type.scalar) {
    case "string":
      return (r, target, wireType) => {
        target[key] = wireType === Wire.WIRE_LEN ? r.string() : wrongWireType(wireType, Wire.WIRE_LEN)
      }
    case "bool":
      return (r, target, wireType) => {
        target[key] = wireType === Wire.WIRE_VARINT ? r.bool() : wrongWireType(wireType, Wire.WIRE_VARINT)
      }
    case "double":
      return (r, target, wireType) => {
        target[key] = wireType === Wire.WIRE_I64 ? r.double() : wrongWireType(wireType, Wire.WIRE_I64)
      }
    case "int32":
      return (r, target, wireType) => {
        target[key] = wireType === Wire.WIRE_VARINT ? r.int32() : wrongWireType(wireType, Wire.WIRE_VARINT)
      }
    case "uint32":
      return (r, target, wireType) => {
        target[key] = wireType === Wire.WIRE_VARINT ? r.varint32() : wrongWireType(wireType, Wire.WIRE_VARINT)
      }
    case "int64":
      return (r, target, wireType) => {
        if (wireType !== Wire.WIRE_VARINT) wrongWireType(wireType, Wire.WIRE_VARINT)
        r.varint64()
        target[key] = Wire.int64FromHalves(r.lo, r.hi)
      }
    case "uint64":
      return (r, target, wireType) => {
        if (wireType !== Wire.WIRE_VARINT) wrongWireType(wireType, Wire.WIRE_VARINT)
        r.varint64()
        target[key] = Wire.uint64FromHalves(r.lo, r.hi)
      }
  }
  return undefined
}

function readSingular(
  r: Input,
  previous: unknown,
  read: FieldReader,
  option: boolean,
  nullable: boolean,
  wireType: number,
  number: number,
  depth: number
): unknown {
  const value = read(r, present(option, nullable, previous), wireType, number, depth)
  return option ? Option.some(value) : value
}

function readList(
  r: Input,
  previous: unknown,
  read: FieldReader,
  readPacked: PackedReader | undefined,
  option: boolean,
  nullable: boolean,
  wireType: number,
  number: number,
  depth: number
): unknown {
  const list = (present(option, nullable, previous) ?? []) as Array<unknown>
  readElements(r, list, read, readPacked, wireType, number, depth)
  return option ? Option.some(list) : list
}

function readRecord(
  r: Input,
  previous: unknown,
  readEntry: EntryReader,
  option: boolean,
  nullable: boolean,
  wireType: number,
  depth: number
): unknown {
  const record = present(option, nullable, previous) ?? {}
  readEntry(r, record, wireType, depth)
  return option ? Option.some(record) : record
}

interface CaseInfo {
  readonly field: L.Case
  readonly number: number
  readonly read: FieldReader
  readonly option: boolean
  readonly nullable: boolean
  // Set when the case merges with an earlier occurrence of itself.
  readonly select: ((value: unknown) => L.Case | undefined) | undefined
  readonly unwrap: (value: unknown) => unknown
  readonly member: L.Case["unwrap"]
  readonly tagged: boolean
}

function caseInfo(compiled: Map<L.Message, Compiled>, field: L.Case): CaseInfo {
  const oneof = field.oneof
  return {
    field,
    number: field.number,
    read: valueReader(compiled, field.type),
    option: oneof.absent === "none",
    nullable: oneof.nullable,
    select: merges(field.type) ? oneof.select : undefined,
    unwrap: caseValue(field),
    member: field.unwrap,
    tagged: oneof.tagged
  }
}

// A later occurrence of a case merges into its value, and an occurrence of
// another case replaces it.
function readCase(r: Input, previous: unknown, info: CaseInfo, wireType: number, depth: number): unknown {
  let before: unknown = undefined
  if (info.select !== undefined) {
    const value = present(info.option, info.nullable, previous)
    if (value !== undefined && info.select(value) === info.field) before = info.unwrap(value)
  }
  let value = info.read(r, before, wireType, info.number, depth)
  const member = info.member
  if (member !== undefined) {
    const struct: Record<string, unknown> = {}
    for (const [k, literal] of member.literals) InternalRecord.assignProperty(struct, k, literal)
    InternalRecord.assignProperty(struct, member.key, value)
    value = struct
  }
  if (info.tagged) value = new CaseValue(info.number, value)
  return info.option ? Option.some(value) : value
}

// Reads one occurrence of a repeated field into `list`: an element, or the
// elements of a packed field.
function readElements(
  r: Input,
  list: Array<unknown>,
  read: FieldReader,
  readPacked: PackedReader | undefined,
  wireType: number,
  number: number,
  depth: number
): void {
  try {
    if (wireType === Wire.WIRE_LEN && readPacked !== undefined) {
      const end = r.delimited()
      readPacked(r, end, list)
      if (r.pos !== end) throw new Wire.WireError("packed element overruns its field")
    } else {
      list.push(read(r, undefined, wireType, number, depth))
    }
  } catch (e) {
    rethrowAt(e, list.length)
  }
}

// Reads the elements of a packed field up to `end`.
type PackedReader = (r: Input, end: number, list: Array<unknown>) => void

function packedReader(type: L.Scalar | L.Enum): PackedReader {
  const read = packableCodec(type).read
  const size = type._tag === "Scalar" && !type.asNumber && (type.scalar === "double" || type.scalar === "float")
    ? fixedSize(type)
    : 0
  if (size === 0) {
    return (r, end, list) => {
      while (r.pos < end) list.push(read(r))
    }
  }
  // Elements that fill the field exactly are read without bounds checks.
  return (r, end, list) => {
    if ((end - r.pos) % size !== 0) {
      while (r.pos < end) list.push(read(r))
      return
    }
    const view = r.view
    if (size === 8) {
      for (let p = r.pos; p < end; p += 8) list.push(view.getFloat64(p, true))
    } else {
      for (let p = r.pos; p < end; p += 4) list.push(view.getFloat32(p, true))
    }
    r.pos = end
  }
}

// Reads a map entry into `record`. A missing key or value is its zero value.
type EntryReader = (r: Input, record: any, wireType: number, depth: number) => void

function entryReader(compiled: Map<L.Message, Compiled>, field: L.MapField | L.Rest): EntryReader {
  const readKey = valueReader(compiled, field.keyType)
  const readValue = valueReader(compiled, field.value)
  const keyZero = L.zeroOf(field.keyType)
  const valueZero = zeroReader(compiled, field.value)
  const owns = field._tag === "Rest" ? field.owns : undefined
  return (r, record, wireType, depth) => {
    if (wireType !== Wire.WIRE_LEN) wrongWireType(wireType, Wire.WIRE_LEN)
    const end = r.delimited()
    let key: unknown = undefined
    let value: unknown = undefined
    while (r.pos < end) {
      const tag = r.tag()
      switch (tag >>> 3) {
        case 1:
          key = readKey(r, undefined, tag & 7, 1, depth)
          break
        case 2:
          value = readValue(r, value, tag & 7, 2, depth)
          break
        default:
          r.skip(tag & 7, tag >>> 3, depth)
      }
    }
    if (r.pos !== end) throw new Wire.WireError("map entry overruns its field")
    const k = String(key === undefined ? keyZero : key)
    if (owns !== undefined && !owns(k)) return
    InternalRecord.assignProperty(record, k, value === undefined ? valueZero(r, depth) : value)
  }
}

// The value of a field without content: a message read from no bytes.
function zeroReader(compiled: Map<L.Message, Compiled>, type: L.Type): (r: Input, depth: number) => unknown {
  switch (type._tag) {
    case "Message":
    case "Converted": {
      const read = fieldsReader(compiled, type)
      return (r, depth) => read(r, undefined, r.pos, undefined, depth + 1)
    }
    default: {
      const zero = L.zeroOf(type)
      return () => zero
    }
  }
}

// Reads a value of a field, given the value of an earlier occurrence. Messages
// are read in either encoding, whichever the field declares.
function valueReader(compiled: Map<L.Message, Compiled>, type: L.Type): FieldReader {
  switch (type._tag) {
    case "Scalar":
      return scalarReader(type)
    case "Enum":
      return (r, _, wireType) => {
        if (wireType !== Wire.WIRE_VARINT) wrongWireType(wireType, Wire.WIRE_VARINT)
        return L.enumValue(type, r.int32())
      }
    case "Symbol":
      return (r, _, wireType) => {
        if (wireType !== Wire.WIRE_LEN) wrongWireType(wireType, Wire.WIRE_LEN)
        return Symbol.for(r.string())
      }
    case "Null":
      return (r, _, wireType) => {
        if (wireType !== Wire.WIRE_VARINT) wrongWireType(wireType, Wire.WIRE_VARINT)
        r.varint64()
        return null
      }
    case "Message": {
      const message = compile(compiled, type.message)
      return (r, previous, wireType, number, depth) => {
        if (wireType === Wire.WIRE_SGROUP) return readMessage(r, message, previous, r.buf.length, number, depth + 1)
        if (wireType !== Wire.WIRE_LEN) wrongWireType(wireType, Wire.WIRE_LEN)
        return readMessage(r, message, previous, r.delimited(), undefined, depth + 1)
      }
    }
    default: {
      const read = fieldsReader(compiled, type)
      return (r, previous, wireType, number, depth) => {
        if (wireType === Wire.WIRE_SGROUP) return read(r, previous, r.buf.length, number, depth + 1)
        if (wireType !== Wire.WIRE_LEN) wrongWireType(wireType, Wire.WIRE_LEN)
        return read(r, previous, r.delimited(), undefined, depth + 1)
      }
    }
  }
}

// The common scalars have their own readers, which skip the indirection of the
// others.
function scalarReader(type: L.Scalar): FieldReader {
  switch (type.asNumber ? undefined : type.scalar) {
    case "string":
      return (r, _, wireType) => wireType === Wire.WIRE_LEN ? r.string() : wrongWireType(wireType, Wire.WIRE_LEN)
    case "bool":
      return (r, _, wireType) => wireType === Wire.WIRE_VARINT ? r.bool() : wrongWireType(wireType, Wire.WIRE_VARINT)
    case "double":
      return (r, _, wireType) => wireType === Wire.WIRE_I64 ? r.double() : wrongWireType(wireType, Wire.WIRE_I64)
    case "int32":
      return (r, _, wireType) => wireType === Wire.WIRE_VARINT ? r.int32() : wrongWireType(wireType, Wire.WIRE_VARINT)
    case "uint32":
      return (r, _, wireType) =>
        wireType === Wire.WIRE_VARINT ? r.varint32() : wrongWireType(wireType, Wire.WIRE_VARINT)
  }
  const expected = type.wireType
  const read = scalarCodec(type).read
  return (r, _, wireType) => wireType === expected ? read(r) : wrongWireType(wireType, expected)
}

function concat(chunks: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

// Fails for the first `Invalid` value in a decoded value, with its path.
function rejectInvalid(value: unknown): void {
  const path: Array<PropertyKey> = []
  const found = findInvalid(value, path)
  if (found === undefined) return
  const e = new Wire.WireError(found.reason)
  e.path.push(...path)
  throw e
}

function findInvalid(value: unknown, path: Array<PropertyKey>): Invalid | undefined {
  if (value instanceof Invalid) return value
  if (typeof value !== "object" || value === null) return undefined
  if (Option.isOption(value)) return Option.isSome(value) ? findInvalid(value.value, path) : undefined
  if (value instanceof CaseValue) return findInvalid(value.value, path)
  // Decoded collections are arrays and plain objects.
  const proto = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return undefined
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length" && Array.isArray(value)) continue
    const found = findInvalid((value as Record<PropertyKey, unknown>)[key], path)
    if (found !== undefined) {
      path.unshift(Array.isArray(value) ? Number(key) : key)
      return found
    }
  }
  return undefined
}
