package jsonstrict

import "testing"

// The guard reads bytes, so every shape that reaches it has to be decided the
// same way a decoder would. A valid pair decodes to one code point and is not
// a loss. A lone surrogate decodes to U+FFFD and is. An escaped backslash
// spells a literal backslash, so the "u" that follows it is data.
func TestUnpairedSurrogateEscape(t *testing.T) {
	cases := []struct {
		name    string
		content string
		refused bool
	}{
		{name: "no escape", content: `{"a":"x"}`},
		{name: "valid pair", content: `{"a":"😀"}`},
		{name: "lone high", content: `{"a":"\ud800"}`, refused: true},
		{name: "lone low", content: `{"a":"\udc00"}`, refused: true},
		{name: "high at range edges", content: `{"a":"\udbff"}`, refused: true},
		{name: "low at range edges", content: `{"a":"\udfff"}`, refused: true},
		{name: "low then high", content: `{"a":"\ude00\ud83d"}`, refused: true},
		{name: "high then high", content: `{"a":"\ud800\ud800"}`, refused: true},
		{name: "low then low", content: `{"a":"\ude00\ude00"}`, refused: true},
		{name: "high then plain", content: `{"a":"\ud800x"}`, refused: true},
		{name: "high then closing quote", content: `{"a":"\ud800"}`, refused: true},
		{name: "high then end of input", content: `{"a":"\ud800`, refused: true},
		{name: "high then high then low", content: `{"a":"\ud800\ud800\udc00"}`, refused: true},
		{name: "high and pair", content: `{"a":"\ud800😀"}`, refused: true},
		{name: "pair then high", content: `{"a":"😀\ud800"}`, refused: true},
		{name: "surrogate in key", content: `{"\ud800":"v"}`, refused: true},
		{name: "escaped backslash then u", content: `{"a":"\\ud800"}`},
		{name: "escaped backslash then real escape", content: `{"a":"\\\ud800"}`, refused: true},
		{name: "lowercase hex pair", content: `{"a":"😀"}`},
		{name: "uppercase hex pair", content: `{"a":"😀"}`},
		{name: "uppercase hex lone high", content: `{"a":"\uD800"}`, refused: true},
		{name: "real U+FFFD", content: `{"a":"�"}`},
		{name: "escaped U+FFFD", content: `{"a":"�"}`},
		{name: "other escapes", content: `{"a":"q\"\\/bfnrt"}`},
		{name: "truncated escape", content: `{"a":"\u12"}`},
		{name: "non hex escape", content: `{"a":"\uzzzz"}`},
		{name: "trailing backslash", content: `{"a":"\`},
		{name: "empty", content: ""},
		{name: "backslashes outside a string", content: `{"a":"x"} \ud800`},
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
