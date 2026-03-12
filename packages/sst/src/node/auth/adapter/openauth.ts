import { BaseClient, Issuer, TokenSet } from "openid-client";
import { createDecoder } from 'fast-jwt';
import { createAdapter } from "./adapter.js";
import { OauthAdapter, OauthBasicConfig } from "./oauth.js";
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

type OpenauthConfig = Omit<OauthBasicConfig, "clientSecret" | 'scope'> & {
  issuer: string;
  onSuccess: (claims: any, tokenset: TokenSet, client: BaseClient) => Promise<APIGatewayProxyStructuredResultV2>;
};

export const OpenauthAdapter = /* @__PURE__ */ createAdapter(
  (config: OpenauthConfig) => {
    return OauthAdapter({
      ...config,
      issuer: new Issuer({
        issuer: config.issuer,
        authorization_endpoint: config.issuer + "/authorize",
        token_endpoint: config.issuer + "/token",
      }),
      clientSecret: "",
      scope: "",
      clientMetadata: {
        token_endpoint_auth_method: "none",
      },
      onSuccess(tokenset, client) {
        const decoder = createDecoder();
        const claims = decoder(tokenset.access_token!)

        return config.onSuccess(claims, tokenset, client);
      },
    });
  }
);
