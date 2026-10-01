package jsonstrict

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// Unrepresentable answers both doors. The refusal-free rows carry the weight:
// a rule that refused every non-ASCII document would pass a table that has only
// refusal rows, and that rule would reject a reviewed policy holding any
// ordinary Unicode.
func TestUnrepresentableNamesEveryDoorAndNothingElse(t *testing.T) {
	cases := []struct {
		name    string
		content string
		reason  string
	}{
		{name: "plain ASCII", content: `{"a":"x"}`},
		{name: "raw emoji", content: `{"a":"` + "\U0001F600" + `"}`},
		{name: "well-formed pair", content: `{"a":"\ud83d\ude00"}`},
		{name: "ordinary escape", content: `{"a":"\u0041"}`},
		{name: "escaped backslash", content: `{"a":"\\ud800"}`},

		{name: "unreadable byte", content: "{\"a\":\"x\xffy\"}", reason: ReasonNotUTF8},
		{name: "truncated utf8", content: "{\"a\":\"\xc3\"}", reason: ReasonNotUTF8},
		{name: "escaped high surrogate", content: `{"a":"\ud800"}`, reason: ReasonLoneSurrogateEscape},
		{name: "escaped low surrogate", content: `{"a":"\udc00"}`, reason: ReasonLoneSurrogateEscape},
		{name: "lone escape in a key", content: `{"\ud800":"v"}`, reason: ReasonLoneSurrogateEscape},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := Unrepresentable([]byte(testCase.content)); got != testCase.reason {
				t.Fatalf("Unrepresentable = %q, want %q", got, testCase.reason)
			}
		})
	}
}

// A reader has to be able to name itself, because the cause an operator reads
// is only useful when it says which read failed. An empty name would produce a
// sentence that starts mid-clause.
func TestRefusalNamesTheReaderAndReturnsNilWhenNothingIsLost(t *testing.T) {
	err := Refusal("unity enrollment policy", []byte(`{"a":"x"}`))
	if err != nil {
		t.Fatalf("a clean document was refused: %v", err)
	}
	err = Refusal("unity enrollment policy", []byte(`{"a":"\ud800"}`))
	if err == nil {
		t.Fatal("an escaped lone surrogate was accepted")
	}
	if got := err.Error(); got != "unity enrollment policy "+ReasonLoneSurrogateEscape {
		t.Fatalf("error = %q, want the reader name and the reason", got)
	}
	if got := Reason(err); got != "unity enrollment policy "+ReasonLoneSurrogateEscape {
		t.Fatalf("Reason = %q, want the same cause as the message", got)
	}
}

// A caller wraps the refusal with %w and loses the cause only if Reason cannot
// see through the wrapping. The published cause is the whole point of the
// error type, so the wrapped form is the form under test.
func TestReasonSurvivesWrappingAndIgnoresOtherErrors(t *testing.T) {
	refusal := Refusal("active rules response", []byte("{\"a\":\"\xff\"}"))
	wrapped := fmt.Errorf("read active rules: %w", refusal)
	if got := Reason(wrapped); got != "active rules response "+ReasonNotUTF8 {
		t.Fatalf("Reason = %q, want the cause through two wrappers", got)
	}
	if got := Reason(errors.New("GitHub API status 500")); got != "" {
		t.Fatalf("Reason = %q, want empty for an error that carries no cause", got)
	}
	if got := Reason(nil); got != "" {
		t.Fatalf("Reason = %q, want empty for a nil error", got)
	}
}

// Label attaches the read that failed to a cause. A transport failure is left
// alone, so a published cause never claims the response content was at fault
// when the request never arrived.
func TestLabelNamesTheReadAndLeavesOtherErrorsAlone(t *testing.T) {
	bare := UnrepresentableErrorf(ReasonNotUTF8)
	if got := Label("ruleset 42 response", bare).Error(); got != "ruleset 42 response "+ReasonNotUTF8 {
		t.Fatalf("Label = %q, want the read and the reason", got)
	}
	transport := errors.New("GitHub API status 500")
	if got := Label("ruleset 42 response", transport); !errors.Is(got, transport) {
		t.Fatalf("Label = %v, want the transport error unchanged", got)
	}
}

// A cause is published in a retained artifact and in a one-line Markdown table
// row. A pipe, a newline, or a non-ASCII byte would either break the row or
// carry text the audited system wrote, and the two issue validators are the
// last line of defence. This pins the property those validators rely on.
func TestReasonsAreSingleLinePublishableClauses(t *testing.T) {
	for _, reason := range []string{ReasonNotUTF8, ReasonLoneSurrogateEscape} {
		if reason == "" || reason != strings.TrimSpace(reason) {
			t.Fatalf("reason %q is not a clause", reason)
		}
		for _, char := range reason {
			switch {
			case char == '|', char == '\n', char == '\r':
				t.Fatalf("reason %q holds a Markdown table break", reason)
			case char < 0x20, char > 0x7e:
				t.Fatalf("reason %q holds a non-printable or non-ASCII byte", reason)
			}
		}
	}
}

// A cause is built from a file name nobody wrote and reaches a retained
// artifact, a one-line Markdown table row, and a shell-rendered run summary.
// Every rune outside CauseAlphabet has to become '?', and the length has to
// stay inside MaxCauseBytes, or a validator refuses the whole artifact and the
// alert never opens at all. The first row is the control: it shows the test
// would also accept a value the sanitizer damaged when it should not have.
func TestSanitizeCauseMapsEveryHostileInputIntoTheAlphabet(t *testing.T) {
	publishable := regexp.MustCompile("^[" + CauseAlphabet + "]{0," +
		strconv.Itoa(MaxCauseBytes) + "}$")
	cases := []struct {
		name  string
		value string
		want  string
	}{
		{
			name:  "reviewed reason",
			value: "load exact snapshot: policy file scripts/unity/editor-check.ps1 is not valid UTF-8",
			want:  "load exact snapshot: policy file scripts/unity/editor-check.ps1 is not valid UTF-8",
		},
		{
			name:  "unreadable byte",
			value: "policy file unity-\xffbuild.yml",
			want:  "policy file unity-?build.yml",
		},
		{name: "pipe", value: "policy file | unity", want: "policy file ? unity"},
		{name: "backtick", value: "policy file `unity`", want: "policy file ?unity?"},
		{name: "newline", value: "policy file\ncredential=value", want: "policy file?credential?value"},
		{name: "angle bracket", value: "policy file <unity>", want: "policy file ?unity?"},
		{name: "tab", value: "policy file\tunity", want: "policy file?unity"},
		{name: "non ascii", value: "policy file naïve", want: "policy file na?ve"},
		{
			name:  "oversized",
			value: strings.Repeat("a", MaxCauseBytes+50),
			want:  strings.Repeat("a", MaxCauseBytes),
		},
		{
			// The cut is a byte cut, so a multi-byte rune never reaches the
			// output half written.
			name:  "oversized non ascii",
			value: strings.Repeat("é", 200),
			want:  strings.Repeat("?", 128),
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := SanitizeCause(testCase.value)
			if got != testCase.want {
				t.Fatalf("SanitizeCause(%q) = %q, want %q", testCase.value, got, testCase.want)
			}
			if len(got) > MaxCauseBytes {
				t.Fatalf("cause is %d bytes, want at most %d", len(got), MaxCauseBytes)
			}
			if !publishable.MatchString(got) {
				t.Fatalf("cause %q is outside the issue alphabet", got)
			}
		})
	}
}
