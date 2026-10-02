// Package runnotice publishes a monitor's conclusion where an operator reads it
// first: the job summary and the annotations tab.
//
// A monitor that keeps a known condition a successful run outcome must name that
// condition in both places. One line in a step log is not evidence an operator
// collects, and a green run that only looks clean in a log is the failure this
// package exists to remove.
//
// Publication fails closed. A conclusion the run cannot publish is evidence the
// run did not read, so the caller must fail rather than print a verdict nobody
// will see.
package runnotice

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

const summaryFileMode = 0o600

// ErrUnstatedReason reports that a caller offered a reason code with no stated
// meaning. It is the only refusal this package raises about the reason
// vocabulary, because only the caller owns that vocabulary.
var ErrUnstatedReason = errors.New("run reason code has no published meaning")

var (
	errNoSummaryPath = errors.New("no run summary path is set")
	errNoReasonCode  = errors.New("run reason code is empty")
	errBrokenSummary = errors.New("run notice contains a line break")
	errSummaryWrite  = errors.New("run summary file is not writable")
	errAnnotations   = errors.New("the annotation stream refused the run notice")
)

// Notice is one monitor verdict before it reaches either channel.
type Notice struct {
	// Meaning states what the reason concluded, as one sentence. It is required.
	// A bare reason code leaves an operator to guess the consequence.
	Meaning string
	// Reason is the monitor's own reason code.
	Reason string
	// Handle names the exact input an operator acts on. A handle is what makes a
	// conclusion alerting, so an alerting conclusion can never be published
	// without naming what to act on. An empty handle publishes no annotation.
	Handle string
}

// Reporter publishes conclusions for one step.
type Reporter struct {
	summaryPath string
	annotations io.Writer
}

// New returns a Reporter. The summary path is required: without it the run has
// no place to state its conclusion, which is the failure this package exists to
// prevent. An absent annotation stream publishes the summary and refuses the
// annotation.
func New(summaryPath string, annotations io.Writer) *Reporter {
	return &Reporter{summaryPath: strings.TrimSpace(summaryPath), annotations: annotations}
}

// Publish states one conclusion in both channels.
//
// The summary carries the meaning, the reason code, and the handle. The
// annotation repeats that line without its Markdown, so the two channels cannot
// drift apart. Both texts are one line: the summary is Markdown, but the
// annotation is a workflow command.
//
// The annotation escapes the way the committed JavaScript runtimes escape
// (`.github/dist/build-lock.js`, `workflowCommandData`). The runner decodes
// `%0D`, `%0A`, and `%25` inside a command message, so an unescaped value could
// carry an encoded line break into the message and end the command early. The
// summary takes the raw form because it is Markdown.
func (reporter *Reporter) Publish(notice Notice) error {
	if strings.TrimSpace(notice.Meaning) == "" {
		return ErrUnstatedReason
	}
	if strings.TrimSpace(notice.Reason) == "" {
		return errNoReasonCode
	}
	summary := notice.Meaning + " Reason: `" + notice.Reason + "`."
	warning := ""
	if notice.Handle != "" {
		summary += " " + notice.Handle
		warning = strings.ReplaceAll(summary, "`", "")
	}
	// One check covers both channels: the annotation is the summary without its
	// Markdown, so it cannot hold a break the summary does not.
	if summary != singleLine(summary) {
		return errBrokenSummary
	}
	if reporter.summaryPath == "" {
		return errNoSummaryPath
	}
	// The summary is written first because it is the durable record.
	file, err := os.OpenFile(reporter.summaryPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, summaryFileMode)
	if err != nil {
		return fmt.Errorf("%w: %w", errSummaryWrite, err)
	}
	_, writeErr := io.WriteString(file, summary+"\n")
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		return fmt.Errorf("%w: %w", errSummaryWrite, errors.Join(writeErr, closeErr))
	}
	if warning == "" {
		return nil
	}
	if reporter.annotations == nil {
		return errAnnotations
	}
	if _, err := fmt.Fprintf(reporter.annotations, "::warning::%s\n", escapeCommandData(warning)); err != nil {
		return fmt.Errorf("%w: %w", errAnnotations, err)
	}
	return nil
}

// singleLine folds any line break to a space so a caller can compare one line
// against its own text.
func singleLine(value string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(value)
}

// escapeCommandData escapes the percent sign in a workflow command. The runner
// decodes %0D, %0A, and %25 inside a command message, so this also neutralises
// the two encoded forms: a value cannot carry a real line break past the refusal
// above, so escaping the percent sign alone covers all three.
func escapeCommandData(value string) string {
	return strings.ReplaceAll(value, "%", "%25")
}
