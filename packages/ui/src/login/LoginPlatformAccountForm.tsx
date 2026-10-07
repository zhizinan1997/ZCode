/**
 * 平台账号登录表单。
 *
 * 与 OAuth 的区别：凭据由用户在表单里提交，host 直接向平台后端换取会话并落盘；
 * 不打开浏览器，也没有 deep link 回调。成功后由父组件写入全局 user，
 * 统一登录入口沿用既有的"观察到 user 即自动收尾"机制关闭。
 */
import { useState } from "react";
import type { UserInfo } from "@zcode/shared";
import {
  TID_LOGIN_PLATFORM_EMAIL_INPUT,
  TID_LOGIN_PLATFORM_ERROR,
  TID_LOGIN_PLATFORM_FORM,
  TID_LOGIN_PLATFORM_PASSWORD_INPUT,
  TID_LOGIN_PLATFORM_SUBMIT_BUTTON,
  TID_LOGIN_USE_API_KEY_BUTTON,
} from "@zcode/shared";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

interface LoginPlatformAccountFormProps {
  /** 切换到 API key 登录方式（自带密钥的用户）。 */
  onUseApiKey: () => void;
  onSignedIn: (userInfo: UserInfo) => void | Promise<void>;
}

export function LoginPlatformAccountForm({
  onUseApiKey,
  onSignedIn,
}: LoginPlatformAccountFormProps) {
  const { intl } = useZCodeIntl();
  const { oauthService } = useServices();
  const [emailValue, setEmailValue] = useState("");
  const [passwordValue, setPasswordValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = emailValue.trim().length > 0 && passwordValue.length > 0 && !submitting;

  const submit = async () => {
    const email = emailValue.trim();
    if (!email || !passwordValue) {
      setError(intl.formatMessage({ id: "login.platform.emptyError" }));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await oauthService.loginWithPlatformAccount({
        email,
        password: passwordValue,
      });
      await onSignedIn(result.userInfo);
    } catch (submitError) {
      // 失败原因（含服务端文案）直接展示：账号密码场景下用户需要知道是凭据错还是服务不可达。
      logger.error("[LoginPlatformAccount] 平台账号登录失败", { error: submitError });
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4" data-testid={TID_LOGIN_PLATFORM_FORM}>
      <h2 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "login.platform.title" })}
      </h2>

      <div className="space-y-2">
        <Input
          id="login-platform-email"
          type="email"
          size="lg"
          className="h-10 w-full text-ui-base"
          data-testid={TID_LOGIN_PLATFORM_EMAIL_INPUT}
          aria-label={intl.formatMessage({ id: "login.platform.emailPlaceholder" })}
          placeholder={intl.formatMessage({ id: "login.platform.emailPlaceholder" })}
          value={emailValue}
          autoComplete="username"
          autoFocus
          disabled={submitting}
          onChange={(event) => {
            setEmailValue(event.target.value);
            setError(null);
          }}
        />
        <Input
          id="login-platform-password"
          type="password"
          size="lg"
          className="h-10 w-full text-ui-base"
          data-testid={TID_LOGIN_PLATFORM_PASSWORD_INPUT}
          aria-label={intl.formatMessage({ id: "login.platform.passwordPlaceholder" })}
          placeholder={intl.formatMessage({ id: "login.platform.passwordPlaceholder" })}
          value={passwordValue}
          autoComplete="current-password"
          disabled={submitting}
          onChange={(event) => {
            setPasswordValue(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSubmit) {
              void submit();
            }
          }}
        />
      </div>

      {error ? (
        <Alert variant="destructive" data-testid={TID_LOGIN_PLATFORM_ERROR}>
          <TriangleAlertIcon className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Button
          variant="default"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_PLATFORM_SUBMIT_BUTTON}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {submitting ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "login.platform.submit" })}
        </Button>
        <Button
          variant="outline"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_USE_API_KEY_BUTTON}
          disabled={submitting}
          onClick={onUseApiKey}
        >
          {intl.formatMessage({ id: "login.useApiKey" })}
        </Button>
      </div>
    </div>
  );
}
