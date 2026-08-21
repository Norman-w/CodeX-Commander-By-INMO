package privacy

import (
	"regexp"
	"strings"
)

var (
	openAIKey   = regexp.MustCompile(`sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}`)
	githubToken = regexp.MustCompile(`(?:github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})`)
	awsKey      = regexp.MustCompile(`AKIA[0-9A-Z]{16}`)
	unixHome    = regexp.MustCompile(`(?:/Users|/home)/[^/\s]+`)
	windowsHome = regexp.MustCompile(`(?i)[A-Za-z]:\\Users\\[^\\\s]+`)
)

func RedactSecrets(value string) string {
	value = openAIKey.ReplaceAllString(value, "[已隐藏密钥]")
	value = githubToken.ReplaceAllString(value, "[已隐藏令牌]")
	return awsKey.ReplaceAllString(value, "[已隐藏访问密钥]")
}

func SanitizeForVisor(value string, maximum int, sensitiveRoots []string) string {
	result := RedactSecrets(value)
	roots := append([]string(nil), sensitiveRoots...)
	for i := 0; i < len(roots); i++ {
		for j := i + 1; j < len(roots); j++ {
			if len(roots[j]) > len(roots[i]) {
				roots[i], roots[j] = roots[j], roots[i]
			}
		}
	}
	for _, root := range roots {
		if root != "" {
			result = strings.ReplaceAll(result, root, "[工作目录]")
		}
	}
	result = unixHome.ReplaceAllString(result, "[本机目录]")
	result = windowsHome.ReplaceAllString(result, "[本机目录]")
	if maximum < 0 {
		return result
	}
	runes := []rune(result)
	if len(runes) > maximum {
		return string(runes[:maximum])
	}
	return result
}
