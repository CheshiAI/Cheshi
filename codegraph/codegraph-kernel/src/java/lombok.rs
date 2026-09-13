//! lombok for the java extractor.

use super::*;

impl<'t> Walker<'t> {
    // --- Lombok synthesis (#912, languages/java.ts synthesizeLombokMembers) ------------

    pub(super) fn lombok_annotation_names(&self, node: Node<'t>) -> HashSet<String> {
        let mut names = HashSet::new();
        let Some(modifiers) = self.modifiers_child(node) else {
            return names;
        };
        for i in 0..modifiers.named_child_count() {
            let Some(child) = modifiers.named_child(i) else {
                continue;
            };
            if matches!(child.kind(), "marker_annotation" | "annotation") {
                if let Some(name_node) = child.child_by_field_name("name") {
                    if let Some(simple) = self.text(name_node).trim().rsplit('.').next() {
                        if !simple.is_empty() {
                            names.insert(simple.to_string());
                        }
                    }
                }
            }
        }
        names
    }

    pub(super) fn synthesize_lombok_members(&mut self, class_node: Node<'t>, class_row: u32) {
        let class_anns = self.lombok_annotation_names(class_node);
        let class_getter = class_anns.contains("Getter");
        let class_setter = class_anns.contains("Setter");
        let is_data = class_anns.contains("Data");
        let is_value = class_anns.contains("Value");
        let has_builder = class_anns.contains("Builder") || class_anns.contains("SuperBuilder");
        let has_to_string = is_data || is_value || class_anns.contains("ToString");
        let has_equals = is_data || is_value || class_anns.contains("EqualsAndHashCode");
        let log_ann = class_anns
            .iter()
            .find(|a| is_lombok_log_annotation(a))
            .cloned();

        let Some(body) = class_node.child_by_field_name("body") else {
            return;
        };
        let fields: Vec<Node> = (0..body.named_child_count())
            .filter_map(|i| body.named_child(i))
            .filter(|c| c.kind() == "field_declaration")
            .collect();

        let class_has_lombok = class_getter
            || class_setter
            || is_data
            || is_value
            || has_builder
            || has_to_string
            || has_equals
            || log_ann.is_some();
        if !class_has_lombok
            && !fields
                .iter()
                .any(|f| !self.lombok_annotation_names(*f).is_empty())
        {
            return;
        }

        // Members the source already declares (exact `classQN::name` matches).
        let class_qn = self.nodes_meta[class_row as usize].qualified_name.clone();
        let class_name = self.nodes_meta[class_row as usize].name.clone();
        let mut taken_methods: HashSet<String> = HashSet::new();
        let mut taken_fields: HashSet<String> = HashSet::new();
        for m in &self.nodes_meta {
            if m.qualified_name == format!("{class_qn}::{}", m.name) {
                match m.kind {
                    "method" | "function" => {
                        taken_methods.insert(m.name.clone());
                    }
                    "field" | "variable" | "constant" | "property" => {
                        taken_fields.insert(m.name.clone());
                    }
                    _ => {}
                }
            }
        }

        let class_name_node = class_node.child_by_field_name("name").unwrap_or(class_node);

        macro_rules! emit_method {
            ($name:expr, $anchor:expr, $sig:expr, $from:expr, $is_static:expr, $ret:expr) => {{
                let name: String = $name;
                if !name.is_empty() && !taken_methods.contains(&name) {
                    taken_methods.insert(name.clone());
                    self.create_node(
                        "method",
                        &name,
                        $anchor,
                        Extra {
                            visibility: Some(1),
                            signature: Some($sig),
                            docstring: Some(format!("Lombok-generated ({})", $from)),
                            decorators: Some(vec!["lombok".to_string()]),
                            is_static: $is_static,
                            return_type: $ret,
                        },
                    );
                }
            }};
        }

        // Per-field getters/setters.
        for fd in &fields {
            let mods = self
                .modifiers_child(*fd)
                .map(|m| self.text(m))
                .unwrap_or("");
            if word_re("static").is_match(mods) {
                continue;
            }
            let is_final = word_re("final").is_match(mods);
            let field_anns = self.lombok_annotation_names(*fd);
            let field_getter = field_anns.contains("Getter");
            let field_setter = field_anns.contains("Setter");

            let want_getter = class_getter || is_data || is_value || field_getter;
            let want_setter = (class_setter || is_data || field_setter) && !is_final;
            if !want_getter && !want_setter {
                continue;
            }

            let type_node = fd.child_by_field_name("type");
            let type_text = type_node
                .map(|t| self.text(t).trim().to_string())
                .unwrap_or_else(|| "Object".to_string());
            let is_boolean_primitive = type_node
                .map(|t| t.kind() == "boolean_type")
                .unwrap_or(false);
            let return_type = self.normalize_java_type(type_node);

            for i in 0..fd.named_child_count() {
                let Some(vd) = fd.named_child(i) else {
                    continue;
                };
                if vd.kind() != "variable_declarator" {
                    continue;
                }
                let Some(name_node) = vd.child_by_field_name("name") else {
                    continue;
                };
                let field_name = self.text(name_node).trim().to_string();
                if field_name.is_empty() {
                    continue;
                }

                if want_getter {
                    let g = if is_boolean_primitive {
                        if is_prefix_re(&field_name) {
                            field_name.clone()
                        } else {
                            format!("is{}", capitalize(&field_name))
                        }
                    } else {
                        format!("get{}", capitalize(&field_name))
                    };
                    let from = if field_getter {
                        "@Getter"
                    } else if is_data {
                        "@Data"
                    } else if is_value {
                        "@Value"
                    } else {
                        "@Getter"
                    };
                    emit_method!(
                        g.clone(),
                        name_node,
                        format!("{type_text} {g}()"),
                        from,
                        None,
                        return_type.clone()
                    );
                }
                if want_setter {
                    let base = if is_boolean_primitive && is_prefix_re(&field_name) {
                        field_name[2..].to_string()
                    } else {
                        field_name.clone()
                    };
                    let s = format!("set{}", capitalize(&base));
                    let from = if field_setter {
                        "@Setter"
                    } else if is_data {
                        "@Data"
                    } else {
                        "@Setter"
                    };
                    emit_method!(
                        s.clone(),
                        name_node,
                        format!("void {s}({type_text} {field_name})"),
                        from,
                        None,
                        None
                    );
                }
            }
        }

        // Class-level synthesized methods.
        if has_builder {
            let from = if class_anns.contains("SuperBuilder") {
                "@SuperBuilder"
            } else {
                "@Builder"
            };
            emit_method!(
                "builder".to_string(),
                class_name_node,
                format!("static {class_name}.{class_name}Builder builder()"),
                from,
                Some(true),
                Some(format!("{class_name}Builder"))
            );
        }
        if has_to_string {
            let from = if is_data {
                "@Data"
            } else if is_value {
                "@Value"
            } else {
                "@ToString"
            };
            emit_method!(
                "toString".to_string(),
                class_name_node,
                "String toString()".to_string(),
                from,
                None,
                None
            );
        }
        if has_equals {
            let from = if is_data {
                "@Data"
            } else if is_value {
                "@Value"
            } else {
                "@EqualsAndHashCode"
            };
            emit_method!(
                "equals".to_string(),
                class_name_node,
                "boolean equals(Object o)".to_string(),
                from,
                None,
                None
            );
            emit_method!(
                "hashCode".to_string(),
                class_name_node,
                "int hashCode()".to_string(),
                from,
                None,
                None
            );
        }

        // Logger field (@Slf4j and friends).
        if let Some(log_ann) = log_ann {
            if !taken_fields.contains("log") {
                self.create_node(
                    "field",
                    "log",
                    class_name_node,
                    Extra {
                        visibility: Some(2),
                        is_static: Some(true),
                        signature: Some("Logger log".to_string()),
                        docstring: Some(format!("Lombok-generated (@{log_ann})")),
                        decorators: Some(vec!["lombok".to_string()]),
                        ..Extra::default()
                    },
                );
            }
        }
    }
}
