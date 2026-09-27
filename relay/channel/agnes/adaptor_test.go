package agnes

import (
	"encoding/json"
	"testing"

	"github.com/QuantumNous/new-api/common"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestConvertImageRequestExtraBodyMerged 回归：extra_body（含生图参考图）
// 必须合并回出站 body，上游 new-api 的 ImageRequest.MarshalJSON 会丢弃未知字段。
func TestConvertImageRequestExtraBodyMerged(t *testing.T) {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(nil)

	newReq := func(extra map[string]json.RawMessage) dto.ImageRequest {
		return dto.ImageRequest{
			Model:  "agnes-image-2.5-flash",
			Prompt: "a cat",
			Extra:  extra,
		}
	}
	info := &relaycommon.RelayInfo{RelayMode: relayconstant.RelayModeImagesGenerations}

	t.Run("extra_body preserved", func(t *testing.T) {
		extraBody := json.RawMessage(`{"image":["https://example.com/ref.png"]}`)
		req := newReq(map[string]json.RawMessage{"extra_body": extraBody})
		a := &Adaptor{}
		converted, err := a.ConvertImageRequest(c, info, req)
		require.NoError(t, err)
		body, ok := converted.(map[string]json.RawMessage)
		require.True(t, ok, "expected merged map, got %T", converted)
		got, exists := body["extra_body"]
		require.True(t, exists, "extra_body missing from outbound body")
		assert.JSONEq(t, string(extraBody), string(got))
	})

	t.Run("no extra passthrough untouched", func(t *testing.T) {
		req := newReq(nil)
		a := &Adaptor{}
		converted, err := a.ConvertImageRequest(c, info, req)
		require.NoError(t, err)
		_, isMap := converted.(map[string]json.RawMessage)
		assert.False(t, isMap, "without Extra the request should pass through as dto.ImageRequest")
	})

	t.Run("known fields win over extra", func(t *testing.T) {
		extra := map[string]json.RawMessage{
			"prompt":     json.RawMessage(`"hacked"`),
			"extra_body": json.RawMessage(`{"image":[]}`),
		}
		req := newReq(extra)
		a := &Adaptor{}
		converted, err := a.ConvertImageRequest(c, info, req)
		require.NoError(t, err)
		raw, err := common.Marshal(converted)
		require.NoError(t, err)
		var body map[string]json.RawMessage
		require.NoError(t, common.Unmarshal(raw, &body))
		assert.JSONEq(t, `"a cat"`, string(body["prompt"]))
	})
}
