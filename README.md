# KGP_ERP

Automatic login for the IIT Kharagpur ERP (erp.iitkgp.ac.in).

Open ERP and KGP_ERP fills in your roll number, password and security answer,
asks ERP for the OTP, reads the OTP from your Gmail and signs you in.

## Install

1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder.
4. The settings page opens. Enter your roll number and ERP password and press **Save**.

5. Under **Security questions**, press **Fetch my questions from ERP** and type
   the answer to each one. (If you skip this, KGP_ERP asks on the login page the
   first time each question comes up.)

Then click **Log in to ERP** in the popup, or just open ERP.

## Automatic OTP

Nothing to set up. KGP_ERP reads the OTP from the Gmail account(s) you are signed
in to in this browser, using Gmail's inbox feed. The OTP email has to land in the
inbox of one of those accounts. Press **Check Gmail** on the settings page to
confirm KGP_ERP can read it.

If that does not work for you, the settings page has an optional "Gmail API"
method under **Advanced**, which needs your own Google OAuth client ID
(extension Item ID `llebjoaniflgcmdhchmlmiknfpgojkoc`).

## How it behaves

- Never retries by itself after ERP rejects a login, so it cannot lock your account.
- Only uses an OTP email that arrived after the OTP was requested.
- After you log out, it waits for you to press **Log in with KGP_ERP** instead of
  logging straight back in.
- Only looks at the unread-inbox list of your signed-in Gmail, and only uses mail
  from `erpkgp@adm.iitkgp.ac.in`.
- Your password and answers are stored in this browser profile only, unencrypted,
  and are sent only to erp.iitkgp.ac.in. Use it on a computer you trust.

## Files

| File | Purpose |
| --- | --- |
| `content.js` | Runs on the ERP login page and performs the login |
| `background.js` | Gmail connection and OTP lookup |
| `popup.*` | Toolbar popup |
| `options.*` | Settings page |
| `shared.js`, `ui.css` | Shared helpers and styling |
