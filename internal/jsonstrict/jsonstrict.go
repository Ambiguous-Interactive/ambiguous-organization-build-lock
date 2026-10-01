// Package jsonstrict refuses JSON evidence a decoder cannot represent exactly.
//
// encoding/json decodes a string escape for a surrogate code point into
// U+FFFD and returns no error. Go has no value for that code point.
//
// The escape is six valid ASCII bytes. The file is valid UTF-8 and valid
// JSON, so a byte-level encoding check accepts it. A reader then decides
// from a value the repository never wrote. A caller that writes the file
// back commits the substituted text inside a clean commit.
//
// The rule lives here rather than in one caller, so every reader of a
// reviewed file answers the same way. It is separate from the encoding
// check because it sees a different door: a byte the decoder can read
// but has no value for.
package jsonstrict

// UnpairedSurrogateEscape reports whether content holds a \u escape for a
// surrogate code point that has no partner.
//
// The check reads bytes. A decoded value cannot answer the question. A
// substituted U+FFFD and a real U+FFFD are the same three bytes.
//
// It tracks string context, because a backslash is an escape only
// inside a string. A document that is not well-formed JSON therefore
// reports only a well-formed escape, and the decoder keeps ownership
// of the syntax error and its message.
func UnpairedSurrogateEscape(content []byte) bool {
	inString := false
	for index := 0; index < len(content); index++ {
		switch content[index] {
		case '"':
			inString = !inString
		case '\\':
			if !inString || index+1 >= len(content) {
				continue
			}
			if content[index+1] != 'u' {
				// Every other escape is one byte wide, so the next byte is
				// data and not a new escape.
				index++
				continue
			}
			value, ok := hexEscape(content, index+2)
			if !ok {
				// Not a well-formed escape, so the document is not
				// well-formed JSON. The decoder refuses it by name.
				return false
			}
			switch {
			case value >= 0xd800 && value <= 0xdbff:
				// A high surrogate is only valid immediately before its
				// partner.
				partner, ok := lowSurrogateEscape(content, index+6)
				if !ok {
					return true
				}
				index = partner
			case value >= 0xdc00 && value <= 0xdfff:
				// A low surrogate is unpaired when no high surrogate
				// consumed it.
				return true
			}
		}
	}
	return false
}

// lowSurrogateEscape reports whether a low surrogate escape begins at index and
// returns the index of its last byte.
func lowSurrogateEscape(content []byte, index int) (int, bool) {
	if index+1 >= len(content) || content[index] != '\\' || content[index+1] != 'u' {
		return 0, false
	}
	value, ok := hexEscape(content, index+2)
	if !ok || value < 0xdc00 || value > 0xdfff {
		return 0, false
	}
	return index + 5, true
}

// hexEscape decodes the four hexadecimal digits of a \u escape that begin at
// index.
func hexEscape(content []byte, index int) (int, bool) {
	if index+4 > len(content) {
		return 0, false
	}
	value := 0
	for offset := 0; offset < 4; offset++ {
		digit, ok := hexValue(content[index+offset])
		if !ok {
			return 0, false
		}
		value = value*16 + digit
	}
	return value, true
}

func hexValue(character byte) (int, bool) {
	switch {
	case character >= '0' && character <= '9':
		return int(character - '0'), true
	case character >= 'a' && character <= 'f':
		return int(character-'a') + 10, true
	case character >= 'A' && character <= 'F':
		return int(character-'A') + 10, true
	default:
		return 0, false
	}
}
