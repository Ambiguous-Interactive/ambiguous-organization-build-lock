package jsonstrict

import (
	"strings"
	"testing"
)

// The guard reads bytes, so every shape that reaches it has to be decided the
// same way a decoder would. A valid pair decodes to one code point and is not a
// loss. A lone surrogate decodes to U+FFFD and is. An escape that names no
// surrogate is an ordinary value and is not a loss either.
//
// The refusal-free rows carry the weight here. Without a well-formed pair, a
// guard that refused every high surrogate would pass this table, and that guard
// would reject a reviewed policy holding any emoji written as an escape.
// Without an ordinary escape, a guard that refused every `u` escape would also
// pass, and that guard would reject ordinary Unicode in every reviewed file.
func TestUnpairedSurrogateEscape(t *testing.T) {
	cases := []struct {
		name    string
		content string
		refused bool
	}{
		{name: "no escape", content: `{"a":"x"}`},
		{name: "raw emoji", content: `{"a":"` + "\U0001F600" + `"}`},

		// A pair is not a loss, in either hex case, alone or repeated.
		{name: "lowercase hex pair", content: `{"a":"\ud83d\ude00"}`},
		{name: "uppercase hex pair", content: `{"a":"\uD83D\uDE00"}`},
		{name: "mixed case hex pair", content: `{"a":"\ud83D\ude00"}`},
		{name: "two pairs", content: `{"a":"\ud83d\ude00\ud83d\ude00"}`},
		{name: "pair at range edges", content: `{"a":"\udbff\udfff"}`},
		{name: "pair in a key", content: `{"\ud83d\ude00":"v"}`},
		{name: "pair then plain", content: `{"a":"\ud83d\ude00x"}`},

		// An escape that names no surrogate is an ordinary value.
		{name: "ascii escape", content: `{"a":"\u0041"}`},
		{name: "accented escape", content: `{"a":"\u00e9"}`},
		{name: "escaped U+FFFD", content: `{"a":"\ufffd"}`},
		{name: "real U+FFFD", content: `{"a":"` + "\uFFFD" + `"}`},
		{name: "escape just below the range", content: `{"a":"\ud7ff"}`},
		{name: "escape just above the range", content: `{"a":"\ue000"}`},
		{name: "other escapes", content: `{"a":"q\"\\/bfnrt"}`},
		{name: "two ordinary escapes", content: `{"a":"\u0041\uffe9"}`},

		// A lone surrogate is a loss.
		{name: "lone high", content: `{"a":"\ud800"}`, refused: true},
		{name: "lone low", content: `{"a":"\udc00"}`, refused: true},
		{name: "lone high at range edge", content: `{"a":"\udbff"}`, refused: true},
		{name: "lone low at range edge", content: `{"a":"\udfff"}`, refused: true},
		{name: "uppercase hex lone high", content: `{"a":"\uD800"}`, refused: true},
		{name: "lone surrogate in a key", content: `{"\ud800":"v"}`, refused: true},
		{name: "low then high", content: `{"a":"\ude00\ud83d"}`, refused: true},
		{name: "high then high", content: `{"a":"\ud800\ud800"}`, refused: true},
		{name: "low then low", content: `{"a":"\ude00\ude00"}`, refused: true},
		{name: "high then plain", content: `{"a":"\ud800x"}`, refused: true},
		{name: "high at end of input", content: `{"a":"\ud800`, refused: true},
		{name: "high then high then low", content: `{"a":"\ud800\ud800\udc00"}`, refused: true},
		{name: "lone high beside a pair", content: `{"a":"\ud800\ud83d\ude00"}`, refused: true},
		{name: "pair then lone high", content: `{"a":"\ud83d\ude00\ud800"}`, refused: true},

		// A backslash starts an escape only inside a string, and only the `u`
		// form carries a code point.
		{name: "escaped backslash then u", content: `{"a":"\\ud800"}`},
		{
			name:    "escaped backslash then lone surrogate",
			content: `{"a":"\\\ud800"}`,
			refused: true,
		},
		{name: "escaped backslash at end of input", content: `{"a":"\`},
		{name: "lone surrogate outside a string", content: `{"a":"x"} \ud800`},

		// A malformed escape belongs to the decoder, which names the syntax.
		{name: "truncated escape", content: `{"a":"\u12"}`},
		{name: "non hex escape", content: `{"a":"\uzzzz"}`},
		{name: "partly non hex escape", content: `{"a":"\ud80z"}`},
		{name: "empty", content: ""},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			refused := UnpairedSurrogateEscape([]byte(test.content))
			if refused != test.refused {
				t.Fatalf("UnpairedSurrogateEscape(%q) = %t, want %t",
					test.content, refused, test.refused)
			}
		})
	}
}

// A guard that stopped after a fixed prefix would pass every row above, because
// the whole table is small. The escape here sits past 4 KiB, so a bound anywhere
// below that is caught.
func TestUnpairedSurrogateEscapePastTheScanPrefix(t *testing.T) {
	prefix := `{"a":"` + strings.Repeat("p", 5000) + `\ud800"}`
	if !UnpairedSurrogateEscape([]byte(prefix)) {
		t.Fatal("an escape past 5 KB of prefix was not refused")
	}
	clean := `{"a":"` + strings.Repeat("p", 5000) + `\ud83d\ude00"}`
	if UnpairedSurrogateEscape([]byte(clean)) {
		t.Fatal("a well-formed pair past 5 KB of prefix was refused")
	}
}
