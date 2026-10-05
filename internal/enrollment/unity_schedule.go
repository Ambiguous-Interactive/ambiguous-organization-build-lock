package enrollment

import (
	"strconv"
	"strings"

	"go.yaml.in/yaml/v4"
)

// One cron entry bounds the whole workflow to one run per UTC day.
// Fixed minute and hour fields prevent repeated licensed admission.
func boundedUnitySchedule(config *yaml.Node) bool {
	if config == nil || config.Kind != yaml.SequenceNode || len(config.Content) != 1 {
		return false
	}
	entry := config.Content[0]
	if entry.Kind != yaml.MappingNode || len(entry.Content) != 2 || entry.Content[0].Kind != yaml.ScalarNode || entry.Content[0].Value != "cron" {
		return false
	}
	cron := entry.Content[1]
	if cron.Kind != yaml.ScalarNode || cron.Tag != "!!str" {
		return false
	}
	fields := strings.Fields(cron.Value)
	if len(fields) != 5 || !cronInteger(fields[0], 0, 59) || !cronInteger(fields[1], 0, 23) {
		return false
	}
	return boundedCronDateField(fields[2], 1, 31) && boundedCronDateField(fields[3], 1, 12) && boundedCronDateField(fields[4], 0, 6)
}

func cronInteger(value string, minimum, maximum int) bool {
	if value == "" {
		return false
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return false
		}
	}
	number, err := strconv.Atoi(value)
	return err == nil && number >= minimum && number <= maximum
}

// Date fields accept numeric POSIX wildcards, lists, ranges, and steps.
// Unknown syntax fails closed, including names and expressions.
func boundedCronDateField(field string, minimum, maximum int) bool {
	for _, item := range strings.Split(field, ",") {
		parts := strings.Split(item, "/")
		if len(parts) > 2 || (len(parts) == 2 && !cronInteger(parts[1], 1, maximum-minimum+1)) {
			return false
		}
		base := parts[0]
		if base == "*" {
			continue
		}
		bounds := strings.Split(base, "-")
		switch len(bounds) {
		case 1:
			if !cronInteger(base, minimum, maximum) {
				return false
			}
		case 2:
			if !cronInteger(bounds[0], minimum, maximum) || !cronInteger(bounds[1], minimum, maximum) {
				return false
			}
			first, _ := strconv.Atoi(bounds[0])
			last, _ := strconv.Atoi(bounds[1])
			if first > last {
				return false
			}
		default:
			return false
		}
	}
	return true
}
