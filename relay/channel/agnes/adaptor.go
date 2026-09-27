package agnes

import (
	"encoding/json"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/relay/channel/openai"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"

	"github.com/gin-gonic/gin"
)

// Adaptor 代理 Agnes（OpenAI 兼容）。
// 对话/生图与 OpenAI 协议一致，直接复用 openai.Adaptor；
// 唯一差异：生图参考图走 extra_body 透传，而上游 ImageRequest.MarshalJSON
// 会丢弃未知字段，这里在 ConvertImageRequest 里把 Extra 合并回去。
type Adaptor struct {
	openai.Adaptor
}

func (a *Adaptor) GetChannelName() string {
	return "Agnes"
}

func (a *Adaptor) GetModelList() []string {
	return []string{
		"agnes-3.0-flash",
		"agnes-image-2.5-flash",
		"agnes-video-2.5-flash",
	}
}

// ConvertImageRequest 在 JSON 出站 body 里恢复 extra_body 等透传字段。
// multipart（edits）路径沿用 openai.Adaptor 的原逻辑，不做合并。
func (a *Adaptor) ConvertImageRequest(c *gin.Context, info *relaycommon.RelayInfo, request dto.ImageRequest) (any, error) {
	converted, err := a.Adaptor.ConvertImageRequest(c, info, request)
	if err != nil {
		return nil, err
	}
	if len(request.Extra) == 0 {
		return converted, nil
	}
	req, ok := converted.(dto.ImageRequest)
	if !ok {
		return converted, nil
	}
	raw, err := common.Marshal(req)
	if err != nil {
		return nil, err
	}
	var body map[string]json.RawMessage
	if err := common.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	for k, v := range request.Extra {
		if _, exists := body[k]; !exists {
			body[k] = v
		}
	}
	return body, nil
}
