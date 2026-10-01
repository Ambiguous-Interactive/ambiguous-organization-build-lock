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

import (
	"errors"
	"unicode/utf8"
)

// The reasons Unrepresentable names. Each is a clause a caller puts in its own
// sentence, so the wording stays here and every reader answers the same way.
// Both clauses stay inside the alphabet the issue validators accept, because a
// cause reaches a retained artifact and a one-line Markdown table. A comma here
// would refuse the whole artifact at the issue sync, and the finding would never
// be published.
const (
	ReasonNotUTF8             = "is not valid UTF-8"
	ReasonLoneSurrogateEscape = "is an escaped lone surrogate which no JSON decoder can represent"
)

// UnrepresentableError reports that content holds a value encoding/json cannot
// represent exactly.
//
// The reason travels as an error value rather than as message text, because a
// caller wraps this error with %w and publishes only the reason. The rest of a
// read error can carry a transport message that does not belong in retained
// evidence.
type UnrepresentableError struct {
	Reason string
}

func (err UnrepresentableError) Error() string { return err.Reason }

// Unrepresentable names why content holds a value encoding/json cannot
// represent exactly, and returns "" when it holds none.
//
// It answers both doors in one place, so a reader does not have to remember
// that one check is a byte rule and the other is an escape rule.
//
// Call it after a successful decode. A malformed document keeps the decoder's
// own message, which names a cause an operator can act on, and this speaks
// only when the decoder succeeded and still lost something.
func Unrepresentable(content []byte) string {
	if !utf8.Valid(content) {
		return ReasonNotUTF8
	}
	if UnpairedSurrogateEscape(content) {
		return ReasonLoneSurrogateEscape
	}
	return ""
}

// Refusal returns the error a reader returns when Unrepresentable refuses
// content, and nil when it does not. The reader's own name leads the sentence,
// so the cause says which read failed as well as why. It always wants a name:
// a reader that cannot name itself yet labels the bare reason with Label.
func Refusal(what string, content []byte) error {
	reason := Unrepresentable(content)
	if reason == "" {
		return nil
	}
	return UnrepresentableError{Reason: what + " " + reason}
}

// Label names what was being read when a decoder lost a value, so a published
// cause says which read failed as well as why. Every other error is returned
// unchanged, so a transport failure is never restated as a claim about the
// response content.
func Label(what string, err error) error {
	var unrepresentable UnrepresentableError
	if errors.As(err, &unrepresentable) {
		return UnrepresentableError{Reason: what + " " + unrepresentable.Reason}
	}
	return err
}

// Reason returns the publishable cause an error carries, or "" when it carries
// none. It never returns a transport message, so a caller can put the result in
// a retained artifact without publishing what the response held.
func Reason(err error) string {
	var unrepresentable UnrepresentableError
	if errors.As(err, &unrepresentable) {
		return unrepresentable.Reason
	}
	return ""
}

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
//
// The content must already be well-formed JSON. A malformed escape
// makes the answer false rather than an error, because the caller
// decodes first and returns the decoder's own message. Every caller in
// this repository does.
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
