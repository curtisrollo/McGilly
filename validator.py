from validate_email import validate_email

def email_check(email):
    try:
        is_valid = validate_email(email, verify=True)
        if is_valid == True:
            return 1
        else:
            return 0
    except Exception:
        return 0
