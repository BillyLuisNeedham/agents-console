//! The compiled-in Presets: Factory today, then each author's own flow. Read-only.

/// A built-in Plan, compiled in from `presets/<slug>.json`.
pub struct Preset {
    pub slug: &'static str,
    pub json: &'static str,
}

pub const PRESETS: &[Preset] = &[
    Preset {
        slug: "factory-today",
        json: include_str!("presets/factory-today.json"),
    },
    Preset {
        slug: "matt-pocock-main",
        json: include_str!("presets/matt-pocock-main.json"),
    },
    Preset {
        slug: "matt-pocock-quick",
        json: include_str!("presets/matt-pocock-quick.json"),
    },
    Preset {
        slug: "matt-pocock-bug",
        json: include_str!("presets/matt-pocock-bug.json"),
    },
    Preset {
        slug: "matt-pocock-foggy",
        json: include_str!("presets/matt-pocock-foggy.json"),
    },
    Preset {
        slug: "pstack-feature",
        json: include_str!("presets/pstack-feature.json"),
    },
    Preset {
        slug: "pstack-bug-fix",
        json: include_str!("presets/pstack-bug-fix.json"),
    },
    Preset {
        slug: "pclaude-feature",
        json: include_str!("presets/pclaude-feature.json"),
    },
    Preset {
        slug: "pclaude-bug-fix",
        json: include_str!("presets/pclaude-bug-fix.json"),
    },
    Preset {
        slug: "addy-commands",
        json: include_str!("presets/addy-commands.json"),
    },
    Preset {
        slug: "addy-bug-fix",
        json: include_str!("presets/addy-bug-fix.json"),
    },
];

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use ac_protocol::wire::PlanFile;

    use super::PRESETS;

    #[test]
    fn every_preset_is_a_plan_file_with_an_author_and_a_source() {
        for preset in PRESETS {
            let file: PlanFile = serde_json::from_str(preset.json)
                .unwrap_or_else(|e| panic!("{} is not a Plan file: {e}", preset.slug));
            assert_eq!(file.horde, 1, "{} format tag", preset.slug);
            assert!(file.author.is_some(), "{} has no author", preset.slug);
            assert!(file.source.is_some(), "{} has no source", preset.slug);
        }
    }

    #[test]
    fn preset_slugs_are_unique() {
        let mut seen = HashSet::new();
        for preset in PRESETS {
            assert!(seen.insert(preset.slug), "{} is listed twice", preset.slug);
        }
    }
}
