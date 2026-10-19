import { Context, Effect, Schema, SchemaGetter } from "effect"
import * as Protobuf from "effect/encoding/Protobuf"
import { describe, expect, it } from "tstyche"

class Decoding extends Context.Service<Decoding, string>()("Decoding") {}
class Encoding extends Context.Service<Encoding, string>()("Encoding") {}

const User = Schema.Struct({
  id: Protobuf.UInt64.pipe(Protobuf.field(1)),
  name: Schema.String.pipe(Protobuf.field(2))
})

const Checked = Schema.Struct({
  id: Schema.NumberFromString.pipe(
    Schema.decode({
      decode: SchemaGetter.checkEffect(() => Effect.as(Decoding, true)),
      encode: SchemaGetter.checkEffect(() => Effect.as(Encoding, true))
    }),
    Protobuf.field(1)
  )
})

describe("Protobuf", () => {
  it("toCodec decodes the type of the schema from bytes", () => {
    const codec = Protobuf.toCodec(User)
    expect<typeof codec["Type"]>().type.toBe<{ readonly id: bigint; readonly name: string }>()
    expect<typeof codec["Encoded"]>().type.toBe<Uint8Array<ArrayBuffer>>()
  })

  it("field keeps the optionality of a property", () => {
    const schema = Schema.Struct({
      a: Schema.optionalKey(Schema.String).pipe(Protobuf.field(1)),
      b: Schema.optional(Protobuf.Int32).pipe(Protobuf.field(2))
    })
    expect<typeof schema["Type"]>().type.toBe<{ readonly a?: string; readonly b?: number | undefined }>()
  })

  it("toCodec keeps the services of the schema", () => {
    const codec = Protobuf.toCodec(Checked)
    expect<typeof codec["DecodingServices"]>().type.toBe<Decoding>()
    expect<typeof codec["EncodingServices"]>().type.toBe<Encoding>()
  })
})
