use serde::{de::Error as _, Deserialize, Deserializer};

pub fn deserialize_project_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_exact_hex(deserializer, "project:v1:", 64, "project identifier")
}

pub fn deserialize_grant<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_exact_hex(deserializer, "grant:v1:", 16, "grant token")
}

pub fn deserialize_revision<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_exact_hex(deserializer, "sha256:v1:", 64, "content revision")
}

pub fn deserialize_watch_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_exact_hex(deserializer, "watch:v1:", 16, "watch identifier")
}

pub fn deserialize_close_lease<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_exact_hex(deserializer, "close:v1:", 16, "close lease")
}

pub fn deserialize_lifecycle_generation<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_exact_hex(deserializer, "lifecycle:v1:", 16, "lifecycle generation")
}

pub fn deserialize_workflow_generation<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_exact_hex(deserializer, "workflow:v1:", 16, "workflow generation")
}

pub fn is_exact_hex_identifier(value: &str, prefix: &str, hex_length: usize) -> bool {
    value.strip_prefix(prefix).is_some_and(|suffix| {
        suffix.len() == hex_length
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn deserialize_exact_hex<'de, D>(
    deserializer: D,
    prefix: &'static str,
    hex_length: usize,
    label: &'static str,
) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if is_exact_hex_identifier(&value, prefix, hex_length) {
        Ok(value)
    } else {
        Err(D::Error::custom(format!("malformed {label}")))
    }
}
