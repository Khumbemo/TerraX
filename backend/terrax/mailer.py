"""Sending e-mail (password-reset and address-confirmation links) through an SMTP server.

Configure TERRAX_SMTP_HOST, _PORT, _USER, _PASSWORD, _SECURITY (starttls, ssl or none) and _FROM, and TERRAX_PUBLIC_URL
(the links in the messages point there; never at the Host a request names, which anyone can set: that would let a
stranger ask for a reset of your account whose link leads to their site, with your token). Any provider works:
a mail relay of your own, or a transactional service's SMTP endpoint (SES, Postmark, SendGrid, Mailgun, …). Without a
host the server cannot send mail, and the features that need it say so instead of pretending to.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from .config import settings

log = logging.getLogger("terrax.mail")


def can_send() -> bool:
    s = settings()
    return bool(s.smtp_host and s.smtp_from and s.public_url)


def link(path_and_query: str) -> str:
    """An absolute link for a message, always on TERRAX_PUBLIC_URL."""
    return f"{settings().public_url}{path_and_query}"


def send(to: str, subject: str, text: str) -> None:
    """Sends a plain-text message; raises RuntimeError (with the reason) when it cannot."""
    s = settings()
    if not can_send():
        raise RuntimeError("This server is not set up to send e-mail (TERRAX_SMTP_HOST, TERRAX_SMTP_FROM and TERRAX_PUBLIC_URL).")
    msg = EmailMessage()
    msg["From"] = formataddr(("TerraX", s.smtp_from))
    msg["To"] = to
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=s.smtp_from.rsplit("@", 1)[-1] or None)
    msg.set_content(text)
    try:
        if s.smtp_security == "ssl":
            with smtplib.SMTP_SSL(s.smtp_host, s.smtp_port or 465, timeout=20, context=ssl.create_default_context()) as smtp:
                _login_and_send(smtp, msg)
        else:
            with smtplib.SMTP(s.smtp_host, s.smtp_port or 587, timeout=20) as smtp:
                if s.smtp_security == "starttls":
                    smtp.starttls(context=ssl.create_default_context())
                _login_and_send(smtp, msg)
    except (OSError, smtplib.SMTPException) as err:
        log.error("could not send e-mail to %s: %s", to, err)
        raise RuntimeError(f"The e-mail could not be sent ({type(err).__name__}).") from err


def _login_and_send(smtp: smtplib.SMTP, msg: EmailMessage) -> None:
    s = settings()
    if s.smtp_user:
        smtp.login(s.smtp_user, s.smtp_password)
    smtp.send_message(msg)
